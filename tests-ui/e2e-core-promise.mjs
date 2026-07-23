// End-to-end proof of STM's core promise:
//   "enter a key once, then call that service directly from Claude Code —
//    without ever re-pasting or rotating the key."
//
// Hermetic: a fake key + a localhost mock service. Simulates exactly what
// Claude Code's Bash tool does: the model writes a command containing only a
// {{stm:...}} placeholder; the PreToolUse hook rewrites it with the real key;
// that rewritten command is what actually executes. We prove the service
// receives the REAL key while the model/transcript only ever saw the placeholder.
//
// Run: node tests-ui/e2e-core-promise.mjs
// (uses a sandbox keychain service + throwaway DB — never touches real state)
//
// macOS-only: purges its sandbox keychain entries via `security`. Not wired into
// CI (which runs on Linux too); this is a runnable, documented proof for humans.

import http from "node:http";
import { spawnSync, execSync, exec } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Async exec — must NOT use execSync for commands that hit the in-process mock
// server, or execSync blocks Node's event loop and the server can never answer
// (deadlock). CLI (bun) calls don't touch the server, so spawnSync is fine there.
const execP = promisify(exec);

const ROOT = resolve(import.meta.dirname, "..");
const CLI = ROOT + "/src/cli.ts";
const SVC = "subscribetome-e2e";
const DB = "/tmp/stm-e2e.sqlite";
const ENV = { ...process.env, STM_KEYCHAIN_SERVICE: SVC, STM_DB: DB, STM_NO_OPEN: "1" };

function cli(args, opts = {}) {
  return spawnSync("bun", [CLI, ...args], { encoding: "utf8", env: ENV, ...opts });
}
function purgeKeychain() {
  for (let i = 0; i < 20; i++) {
    const r = spawnSync("security", ["delete-generic-password", "-s", SVC], { encoding: "utf8" });
    if (r.status !== 0) break;
  }
}
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}\n`);
}

// ── clean slate ───────────────────────────────────────────────────────────
execSync(`rm -f ${DB}*`);
purgeKeychain();

// ── mock "service": records the Authorization header, never echoes it back ──
const received = [];
const server = http.createServer((req, res) => {
  received.push(req.headers["authorization"] || "");
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"ok":true}');
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

// A realistic-but-fake key (sk- prefix → key-shaped, exercises the real paths).
const SECRET = "sk-e2e-A9b8C7d6E5f4G3h2ZzYyXxWwVvUu0011";
const MASK = SECRET.slice(0, 6) + "…" + SECRET.slice(-3);
process.stdout.write(`\n=== STM end-to-end: enter once → call directly (mock service on :${PORT})\n\n`);

// 1) Enter the key ONCE (this is the only time a human handles it).
const add = cli(["add", "--tool", "mockapi"], { input: SECRET });
check(
  "Key entered exactly once (stm add)",
  add.status === 0 && /added \{\{stm:mockapi:default\}\}/.test(add.stdout),
  (add.stdout || add.stderr).trim().split("\n")[0],
);

// 2) The command the MODEL writes contains only the placeholder — never the key.
const modelCmd = `curl -s -H "Authorization: Bearer {{stm:mockapi:default}}" http://127.0.0.1:${PORT}/`;
check(
  "Model writes only the placeholder (never the key)",
  modelCmd.includes("{{stm:mockapi:default}}") && !modelCmd.includes(SECRET),
);

// 3) PreToolUse rewrites the command with the real key (what Claude Code runs).
const hookIn = JSON.stringify({ tool_name: "Bash", tool_input: { command: modelCmd }, cwd: "/tmp" });
const hook = cli(["hook", "pretooluse"], { input: hookIn });
let realCmd = "";
try {
  realCmd = JSON.parse(hook.stdout)?.hookSpecificOutput?.updatedInput?.command || "";
} catch {}
check("PreToolUse returns allow + rewritten command", hook.status === 0 && realCmd.length > 0);
check(
  "Rewritten command carries the REAL key (injected, not pasted)",
  realCmd.includes(SECRET) && !realCmd.includes("{{stm"),
  "key " + MASK + " swapped in",
);

// 4) Execute exactly what Claude Code's Bash tool would run.
if (realCmd) await execP(realCmd).catch(() => {});
check(
  "The service received the REAL key over the wire",
  received.some((a) => a === `Bearer ${SECRET}`),
  "a real authenticated request reached the mock service",
);

// 5) Call AGAIN — no re-entry, no rotation.
const hook2 = cli(["hook", "pretooluse"], { input: hookIn });
let realCmd2 = "";
try {
  realCmd2 = JSON.parse(hook2.stdout).hookSpecificOutput.updatedInput.command;
} catch {}
if (realCmd2) await execP(realCmd2).catch(() => {});
const hits = received.filter((a) => a === `Bearer ${SECRET}`).length;
check("Repeat call works with no re-paste / no rotate", hits >= 2, hits + " authenticated calls from one entry");

// 6) The key never leaks into the transcript-visible surfaces.
const audit = cli(["audit"]);
check("Key NOT in the audit log (placeholders only)", !(audit.stdout || "").includes(SECRET));
const strings = spawnSync("bash", ["-c", `strings ${DB}`], { encoding: "utf8" });
check("Key NOT in the SQLite DB (keystore-only)", !(strings.stdout || "").includes(SECRET));

// 7) Negative control — without the hook, the placeholder itself is useless.
received.length = 0;
await execP(modelCmd).catch(() => {});
check(
  "Negative control: unsubstituted placeholder does NOT authenticate",
  received.some((a) => a.includes("{{stm:mockapi:default}}")) && !received.some((a) => a.includes(SECRET)),
  "raw placeholder hits the wire as literal text — STM is what makes the call work",
);

// 8) What makes the hook fire inside Claude Code: the plugin's registration.
const hooksJson = readFileSync(ROOT + "/hooks/hooks.json", "utf8");
check(
  "PreToolUse hook is registered for Bash (fires automatically in Claude Code)",
  /PreToolUse/.test(hooksJson) && /Bash/.test(hooksJson),
);

// 9) Codex surface (session-env mode): the same one-entry key is injected as an env var.
const codex = cli(["codex", "--dry-run"]);
const codexOut = (codex.stdout || "") + (codex.stderr || "");
check(
  "Codex reuses the same key (session-env injection plan builds)",
  codex.status === 0 && /not launched|dry run/i.test(codexOut),
  /STM_MOCKAPI_DEFAULT/.test(codexOut) ? "injects STM_MOCKAPI_DEFAULT" : "dry-run plan built",
);

// ── teardown ────────────────────────────────────────────────────────────────
server.close();
execSync(`rm -f ${DB}*`);
purgeKeychain();

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n=== ${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
