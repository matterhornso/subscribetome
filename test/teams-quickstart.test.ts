// `stm teams quickstart` — the guided enrollment path.
//
// quickstart is CLI-layer orchestration over the same client primitives the
// individual subcommands use (createTeam/registerMember/seal/open/pullVault),
// and those are exercised end-to-end in teams.test.ts. What is NOT covered
// there is quickstart's own DISPATCH and argument validation, which live in the
// cli.ts switch. These spawn the real CLI for the hermetic cases — the overview
// and the missing-flag guards — which reach `die()` before any network or
// keychain call, so they need no server and touch no real state.

import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function run(args: string[]): { code: number | null; out: string; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "stm-qs-"));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // Fully isolate: a config path that does not exist yet, a throwaway
    // keychain service, and a throwaway db. The cases under test never reach
    // any of these — they validate args and exit first — but isolate anyway.
    STM_TEAM_CONFIG: join(dir, "teams.json"),
    STM_KEYCHAIN_SERVICE: "stm-qs-unit-test",
    STM_DB: join(dir, "stm.db"),
  };
  // Ensure an admin token in the ambient env can't turn `create` into a real
  // network call instead of the missing-flag error we assert on.
  delete env.STM_TEAM_ADMIN_TOKEN;
  const r = spawnSync("bun", [CLI, ...args], { encoding: "utf8", env });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

test("quickstart overview lists create/join/finish", () => {
  const r = run(["teams", "quickstart"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("the guided path");
  expect(r.out).toContain("quickstart create");
  expect(r.out).toContain("quickstart join");
  expect(r.out).toContain("quickstart finish");
});

test("quickstart create without --server/--admin exits with usage", () => {
  const r = run(["teams", "quickstart", "create"]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("usage: stm teams quickstart create");
});

test("quickstart join without --server/--token exits with usage", () => {
  const r = run(["teams", "quickstart", "join"]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("usage: stm teams quickstart join");
});

test("quickstart finish with no team configured exits cleanly", () => {
  const r = run(["teams", "quickstart", "finish"]);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("not configured");
});

test("teams help surfaces quickstart as the guided path", () => {
  const r = run(["teams", "help"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("stm teams quickstart");
  expect(r.out).toContain("the guided path");
});
