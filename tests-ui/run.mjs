// Runner for the Playwright UI suite.
//   1. Stops any current daemon (so we don't hit the user's real one)
//   2. Spins up a SANDBOX daemon backed by /tmp/stm-ui.* and the
//      `subscribetome-ui-test` keychain service
//   3. Seeds deterministic demo data so the assertions are stable
//   4. Writes the dashboard URL (with per-run token) to /tmp/stm-ui-url.txt
//   5. Runs the Playwright suite
//   6. Tears down the daemon + sandbox keystore entries + temp DB
//
// Usage:  node tests-ui/run.mjs

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = `${ROOT}/src/cli.ts`;
const DB = "/tmp/stm-ui.sqlite";
const KC = "subscribetome-ui-test";
const URL_FILE = "/tmp/stm-ui-url.txt";
const DESC_FILE = `${process.env.HOME}/.subscribetome/daemon.json`;

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
  // Best-effort: delete every entry under our sandbox service.
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

  // 1. Stop any current daemon (user's real one, or a previous test run).
  cli(["stop"]);

  // 2. Wipe any stale sandbox state.
  for (const p of [DB, DB + "-shm", DB + "-wal"]) {
    if (existsSync(p)) rmSync(p);
  }
  sweepKeystore();

  // 3. Seed deterministic data.
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

  // 4. Start the daemon (detached, background).
  const log = `${process.env.HOME}/.subscribetome/.ui-test.log`;
  spawn("bun", [CLI, "daemon"], {
    env: ENV,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  }).unref();

  // 5. Wait for the descriptor to land.
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
  sweepKeystore();
  process.stdout.write("  done\n");
}

let suiteCode = 0;
try {
  await setup();
  const r = spawnSync("bun", ["run", `${ROOT}/tests-ui/dashboard.suite.mjs`], {
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
