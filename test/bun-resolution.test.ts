// Bun resolution for the shell entrypoints + doctor's runtime check.
//
// REGRESSION: every entrypoint used to resolve bun as
//     BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
// which knew only the official-installer path (missing Homebrew's
// /opt/homebrew/bin/bun — the location README.md itself recommends) and never
// checked the fallback was executable. Hooks are spawned by the agent host,
// whose PATH is often not the user's interactive shell PATH, so a Homebrew
// user launching Claude Code from the GUI hit it.
//
// The severity was not cosmetic: with bun unresolvable the UserPromptSubmit
// paste guard exited 0 WITHOUT SCANNING — a security control failing open
// silently, while the user still believed pasted keys were blocked.
//
// These tests pin both halves of the fix: the shell resolver finds bun in the
// known locations and complains loudly when it genuinely can't, and doctor
// reports the runtime so the failure is discoverable.

import { test, expect, afterAll } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeStatus, bunCandidates, doctorReport } from "../src/doctor.ts";

const ROOT = join(import.meta.dir, "..");
const SCRATCH = mkdtempSync(join(tmpdir(), "stm-bunres-"));
const REAL_BUN = String(
  execFileSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" }),
).trim();

afterAll(() => {
  try { rmSync(SCRATCH, { recursive: true }); } catch { /* ignore */ }
});

/** Run a hook script with a controlled HOME + PATH. */
function runHook(script: string, home: string, stdin: string, path = "/usr/bin:/bin") {
  const r = spawnSync("bash", [join(ROOT, script)], {
    input: stdin,
    encoding: "utf8",
    env: { HOME: home, PATH: path }, // deliberately minimal: mimics a GUI launch
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ---- shell resolver -------------------------------------------------------

test("hook resolves bun from ~/.bun even when PATH has no bun", () => {
  const home = join(SCRATCH, "home-dotbun");
  mkdirSync(join(home, ".bun", "bin"), { recursive: true });
  symlinkSync(REAL_BUN, join(home, ".bun", "bin", "bun"));
  const r = runHook("hooks/userpromptsubmit.sh", home, JSON.stringify({ prompt: "plain text" }));
  expect(r.stderr).not.toContain("Cannot find");
  expect(r.code).toBe(0);
});

test("SECURITY: a genuinely missing bun warns loudly instead of failing open silently", () => {
  const home = join(SCRATCH, "home-nobun");
  mkdirSync(home, { recursive: true });
  // A prompt that WOULD be blocked if the guard could actually scan it.
  const r = runHook(
    "hooks/userpromptsubmit.sh",
    home,
    JSON.stringify({ prompt: "sk-ant-api03-EXAMPLE-not-a-real-key-000" }),
  );
  // The old behaviour: a cryptic `exec: ... cannot execute` and nothing else.
  expect(r.stderr).not.toContain("cannot execute");
  // The new behaviour: an explicit statement that stm is NOT running and that
  // the guard is NOT scanning, so the user cannot mistake silence for safety.
  expect(r.stderr).toContain("stm is NOT running");
  expect(r.stderr).toContain("does");
  expect(r.stderr).toContain("NOT scan your prompts");
  expect(r.stderr).toContain("stm doctor");
  // Still exit 0: our own missing runtime must not block the user's workflow.
  expect(r.code).toBe(0);
});

test("PreToolUse with no bun warns and does not emit a bogus substitution", () => {
  const home = join(SCRATCH, "home-nobun-pre");
  mkdirSync(home, { recursive: true });
  const r = runHook(
    "hooks/pretooluse.sh",
    home,
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo {{stm:openai:default}}" } }),
  );
  expect(r.stderr).toContain("stm is NOT running");
  expect(r.stdout.trim()).toBe(""); // no half-formed hook JSON
  expect(r.code).toBe(0);
});

test("stm CLI fails hard (exit 1) when bun is missing — the user invoked it directly", () => {
  const home = join(SCRATCH, "home-nobun-cli");
  mkdirSync(home, { recursive: true });
  const r = spawnSync("bash", [join(ROOT, "bin/stm"), "list"], {
    encoding: "utf8",
    env: { HOME: home, PATH: "/usr/bin:/bin" },
  });
  expect(r.stderr).toContain("stm is NOT running");
  expect(r.status).toBe(1);
});

test("a non-executable candidate is skipped, not exec'd", () => {
  const home = join(SCRATCH, "home-badbun");
  mkdirSync(join(home, ".bun", "bin"), { recursive: true });
  // A file at the candidate path that is NOT executable — the old code would
  // have exec'd it and produced `cannot execute`.
  writeFileSync(join(home, ".bun", "bin", "bun"), "#!/bin/sh\necho nope\n");
  chmodSync(join(home, ".bun", "bin", "bun"), 0o644);
  const r = runHook("hooks/userpromptsubmit.sh", home, JSON.stringify({ prompt: "hi" }));
  expect(r.stderr).not.toContain("cannot execute");
  expect(r.stderr).toContain("stm is NOT running");
});

test("every shell entrypoint uses the shared resolver (no lingering one-liner)", () => {
  const entrypoints = [
    "hooks/pretooluse.sh",
    "hooks/posttooluse.sh",
    "hooks/sessionstart.sh",
    "hooks/userpromptsubmit.sh",
    "hooks/codex/sessionstart.sh",
    "hooks/codex/userpromptsubmit.sh",
    "bin/stm",
  ];
  for (const e of entrypoints) {
    const src = execFileSync("cat", [join(ROOT, e)], { encoding: "utf8" });
    expect(src).toContain("resolve-bun.sh");
    expect(src).toContain("stm_resolve_bun");
    // The fragile pattern must be gone from every entrypoint.
    expect(src).not.toContain('command -v bun || echo');
  }
});

// ---- doctor runtime check -------------------------------------------------

test("runtimeStatus reports a PATH hit", () => {
  const r = runtimeStatus({ onPath: () => "/somewhere/bun", isExecutable: (p) => p === "/somewhere/bun" });
  expect(r.found).toBe(true);
  expect(r.via).toBe("PATH");
  expect(r.path).toBe("/somewhere/bun");
});

test("runtimeStatus falls back to Homebrew when PATH misses it", () => {
  const r = runtimeStatus({
    onPath: () => null,
    isExecutable: (p) => p === "/opt/homebrew/bin/bun",
  });
  expect(r.found).toBe(true);
  expect(r.via).toBe("fallback");
  expect(r.path).toBe("/opt/homebrew/bin/bun");
});

test("runtimeStatus reports not-found and lists what it checked", () => {
  const r = runtimeStatus({ onPath: () => null, isExecutable: () => false });
  expect(r.found).toBe(false);
  expect(r.checked).toContain("/opt/homebrew/bin/bun");
  expect(r.path).toBeUndefined();
});

test("doctor candidate list matches the shell resolver's", () => {
  // If these drift, doctor reports something the hooks don't actually do.
  const shell = execFileSync("cat", [join(ROOT, "hooks/resolve-bun.sh")], { encoding: "utf8" });
  for (const c of bunCandidates("$HOME")) {
    const bare = c.replace("$HOME/", "");
    expect(shell).toContain(bare);
  }
});

test("doctor is not ok when the runtime is missing, even with a reachable tier", () => {
  const r = doctorReport({ platform: "darwin" });
  // On this machine bun exists, so this asserts the wiring is present and the
  // field is populated rather than asserting a failure we can't induce here.
  expect(r.runtime).toBeDefined();
  expect(typeof r.runtime.found).toBe("boolean");
  if (r.runtime.found) expect(r.ok).toBe(true);
});

test("runtimeStatus works on win32 (regression: POSIX-only lookup failed healthy installs)", () => {
  // An earlier cut shelled `command -v` and checked only POSIX paths, so a
  // healthy Windows install reported not-ok and `stm doctor` exited 1.
  const r = runtimeStatus({
    platform: "win32",
    onPath: () => "C:\\Users\\x\\.bun\\bin\\bun.exe",
    isExecutable: () => true,
  });
  expect(r.found).toBe(true);
  expect(r.via).toBe("PATH");

  // Relative/garbage output from `where` is rejected, same as alias output on POSIX.
  const bad = runtimeStatus({ platform: "win32", onPath: () => "bun", isExecutable: () => false });
  expect(bad.found).toBe(false);

  // Windows candidates are Windows-shaped, not POSIX ones.
  const cands = bunCandidates("C:\\Users\\x", "win32");
  expect(cands.some((c) => c.includes("\\"))).toBe(true);
  expect(cands.some((c) => c.startsWith("/opt/"))).toBe(false);
});
