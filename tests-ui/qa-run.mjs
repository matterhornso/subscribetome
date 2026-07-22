// QA runner for the extended Playwright suite (tests-ui/qa.suite.mjs).
// Copy of run.mjs — same sandbox setup/teardown — but it also seeds a
// subscription cost + one audit row so the audit/subscription cases have
// data, and it invokes qa.suite.mjs instead of dashboard.suite.mjs.
//
// Usage:  node tests-ui/qa-run.mjs

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = `${ROOT}/src/cli.ts`;
const DB = "/tmp/stm-ui.sqlite";
const KC = "subscribetome-ui-test";
const URL_FILE = "/tmp/stm-ui-url.txt";
const DESC_FILE = `${process.env.HOME}/.subscribetome/daemon.json`;
const IMPORT_DIR = "/tmp/stm-qa-import";

const ENV = { ...process.env, STM_DB: DB, STM_KEYCHAIN_SERVICE: KC };

function cli(args, opts = {}) {
  return spawnSync("bun", [CLI, ...args], {
    env: ENV,
    encoding: "utf8",
    stdio: "pipe",
    ...opts,
  });
}

function sweepKeystore() {
  for (let i = 0; i < 50; i++) {
    const r = spawnSync(
      "/usr/bin/security",
      ["delete-generic-password", "-s", KC],
      { stdio: "ignore" },
    );
    if (r.status !== 0) break;
  }
}

async function setup() {
  process.stdout.write("=== setting up sandbox\n");
  cli(["stop"]);
  for (const p of [DB, DB + "-shm", DB + "-wal"]) {
    if (existsSync(p)) rmSync(p);
  }
  sweepKeystore();

  function add(tool, label, value = `demo-${tool}-${label}`) {
    const r = spawnSync(
      "bun",
      [CLI, "add", "--tool", tool, "--label", label],
      { input: value + "\n", env: ENV, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" },
    );
    if (r.status !== 0) {
      process.stderr.write(`add failed: ${tool}:${label} — ${r.stderr}\n`);
      process.exit(1);
    }
  }
  add("openai", "default");
  add("openai", "admin-key");
  add("anthropic", "default");
  add("github", "default");
  add("supabase", "service-role-key");
  add("stripe", "default");
  cli(["revoke", "stripe", "default"]);
  cli(["project", "add", `${process.env.HOME}/code/acme-app`, "Acme App"]);
  cli(["policy", "add", "--then", "deny", "--when-key", "stripe:*", "--reason", "test rule"]);

  // Seed a subscription cost on `github` so the spend-source pill + monthly
  // cell have something to show (no fetched data → "self-reported").
  cli(["subscription", "github", "--plan", "Team", "--cost", "20"]);

  // Seed one audit row (a substitute) so the audit table + Clear-log case
  // have data. Resolves the sandbox openai key only — never real state.
  spawnSync("bun", [CLI, "hook", "pretooluse"], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "echo {{stm:openai:default}}" },
    }),
    env: ENV,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf8",
  });

  // A .env fixture dir for the Import tab cases.
  try { rmSync(IMPORT_DIR, { recursive: true, force: true }); } catch {}
  mkdirSync(IMPORT_DIR, { recursive: true });
  writeFileSync(`${IMPORT_DIR}/.env`, "MISTRAL_API_KEY=sk-qa-mistral-abcdef123456\n");

  const log = `${process.env.HOME}/.subscribetome/.ui-test.log`;
  spawn("bun", [CLI, "daemon"], {
    env: ENV,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  }).unref();

  for (let i = 0; i < 30; i++) {
    if (existsSync(DESC_FILE)) break;
    await wait(100);
  }
  if (!existsSync(DESC_FILE)) {
    process.stderr.write("daemon descriptor never appeared\n");
    process.exit(1);
  }
  const desc = JSON.parse(readFileSync(DESC_FILE, "utf8"));
  const url = `http://127.0.0.1:${desc.port}/?token=${desc.token}`;
  writeFileSync(URL_FILE, `URL=${url}\n`);
  process.stdout.write(`  daemon at ${url}\n  pid=${desc.pid}\n\n`);
  return desc;
}

async function teardown() {
  process.stdout.write("\n=== teardown\n");
  cli(["stop"]);
  for (const p of [DB, DB + "-shm", DB + "-wal", URL_FILE]) {
    try { if (existsSync(p)) rmSync(p); } catch {}
  }
  try { rmSync(IMPORT_DIR, { recursive: true, force: true }); } catch {}
  sweepKeystore();
  process.stdout.write("  done\n");
}

let suiteCode = 0;
try {
  await setup();
  const r = spawnSync("bun", ["run", `${ROOT}/tests-ui/qa.suite.mjs`], {
    stdio: "inherit",
    encoding: "utf8",
  });
  suiteCode = r.status ?? 1;
} catch (e) {
  process.stderr.write("RUNNER ERROR: " + (e?.stack ?? e) + "\n");
  suiteCode = 2;
} finally {
  await teardown();
}
process.exit(suiteCode);
