// Broker daemon integration test — the two-token security boundary.
//
// Milestone 2 adds a dedicated broker capability token, separate from the
// dashboard token. The load-bearing property: the broker token authorizes
// /proxy ONLY. It must NOT grant access to /api (the inventory) or the
// dashboard. This test spins up a real, ISOLATED daemon (its own descriptor,
// DB, and keychain service via env overrides so it never touches the user's
// real ~/.subscribetome) and asserts the gating end to end.
//
// The /proxy assertions use an unknown tool so brokerRequest returns 404 before
// any network call — we're testing auth, not upstream reachability.

import { test, expect, afterAll } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const P = process.pid;
const DB = join(tmpdir(), `stm-brokerd-${P}.sqlite`);
const DFILE = join(tmpdir(), `stm-brokerd-${P}.json`);
const KC = `subscribetome-test-brokerd-${P}`;
const ENV = {
  ...process.env,
  STM_DB: DB,
  STM_DAEMON_FILE: DFILE,
  STM_KEYCHAIN_SERVICE: KC,
};

let proc: ChildProcess | null = null;

afterAll(() => {
  try { proc?.kill("SIGTERM"); } catch { /* ignore */ }
  for (const f of [DFILE, DB, DB + "-wal", DB + "-shm"]) {
    try { rmSync(f); } catch { /* ignore */ }
  }
});

interface Info { port: number; token: string; brokerToken: string; pid: number }

async function startDaemon(): Promise<Info> {
  proc = spawn(process.execPath, [CLI, "daemon"], { env: ENV, stdio: "ignore" });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (existsSync(DFILE)) {
      try {
        const info = JSON.parse(readFileSync(DFILE, "utf8")) as Info;
        if (info.port && info.token && info.brokerToken) {
          // Confirm it's actually serving.
          try {
            const h = await fetch(`http://127.0.0.1:${info.port}/api/health`);
            if (h.ok) return info;
          } catch { /* not up yet */ }
        }
      } catch { /* partial write */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("daemon descriptor never appeared / never served");
}

const isDarwinOrLinux = process.platform !== "win32";
const t = isDarwinOrLinux ? test : test.skip;

t("broker token gates /proxy only; dashboard token gates everything", async () => {
  const info = await startDaemon();
  const base = `http://127.0.0.1:${info.port}`;
  const hdr = (tok?: string): Record<string, string> =>
    tok ? { "x-stm-token": tok } : {};

  // /proxy with NO token -> 401
  let r = await fetch(`${base}/proxy/openai/default/v1/x`, { headers: hdr() });
  expect(r.status).toBe(401);

  // /proxy with the BROKER token -> auth passes (unknown tool -> 404, no network)
  r = await fetch(`${base}/proxy/__nope__/default/x`, { headers: hdr(info.brokerToken) });
  expect(r.status).toBe(404);
  expect((await r.json()).error).toContain("no broker target");

  // /proxy with the DASHBOARD token -> also allowed
  r = await fetch(`${base}/proxy/__nope__/default/x`, { headers: hdr(info.token) });
  expect(r.status).toBe(404);

  // THE BOUNDARY: broker token must NOT reach /api (inventory).
  r = await fetch(`${base}/api/inventory`, { headers: hdr(info.brokerToken) });
  expect(r.status).toBe(401);

  // Dashboard token DOES reach /api.
  r = await fetch(`${base}/api/inventory`, { headers: hdr(info.token) });
  expect(r.status).toBe(200);

  // And broker token must NOT open the dashboard.
  r = await fetch(`${base}/?token=${info.brokerToken}`);
  expect(r.status).toBe(403);
});
