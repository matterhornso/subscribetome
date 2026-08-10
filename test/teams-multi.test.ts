// Multi-team membership (Teams M4b): the teams.json container, its migration
// from the legacy single-team file, team selection, and per-team passphrases.
//
// STM_TEAM_CONFIG / STM_KEYCHAIN_SERVICE must be set BEFORE the client module is
// evaluated (it captures the config path at import time), so the module is
// dynamically imported after the env is redirected to sandbox paths.

import { test, expect, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CFG = join(tmpdir(), `stm-teams-multi-${process.pid}.json`);
const KC = `subscribetome-test-multi-${process.pid}`;
process.env.STM_TEAM_CONFIG = CFG;
process.env.STM_KEYCHAIN_SERVICE = KC;

const t = await import("../src/teams/client.ts");

function reset() {
  try { rmSync(CFG); } catch { /* absent */ }
}

afterAll(() => {
  reset();
  // Restore env so a later test file in this process sees the real paths.
  delete process.env.STM_TEAM_CONFIG;
  for (let i = 0; i < 100; i++) {
    try { execFileSync("/usr/bin/security", ["delete-generic-password", "-s", KC], { stdio: "ignore" }); }
    catch { break; }
  }
});

test("migrateTeamsData: legacy single config → one-team container, made current", () => {
  const legacy = { serverUrl: "http://s", teamToken: "tok", teamId: 1, teamName: "Acme Corp", auditCursor: 5 };
  const f = t.migrateTeamsData(legacy);
  expect(f.stmTeams).toBe(2);
  expect(f.teams).toHaveLength(1);
  expect(f.teams[0].name).toBe("acme-corp");
  expect(f.teams[0].auditCursor).toBe(5); // fields preserved
  expect(f.current).toBe("acme-corp");
});

test("migrateTeamsData: empty/garbage → empty container; bad current → first team", () => {
  expect(t.migrateTeamsData(null).teams).toHaveLength(0);
  expect(t.migrateTeamsData({ nonsense: true }).current).toBeNull();
  const container = {
    stmTeams: 2, current: "does-not-exist",
    teams: [{ name: "a", serverUrl: "http://a", teamToken: "x" }, { name: "b", serverUrl: "http://b", teamToken: "y" }],
  };
  expect(t.migrateTeamsData(container).current).toBe("a"); // invalid current repaired
});

test("migrateTeamsData: duplicate local names are de-duplicated", () => {
  const container = {
    stmTeams: 2, current: null,
    teams: [
      { name: "dev", serverUrl: "http://a", teamToken: "x" },
      { name: "dev", serverUrl: "http://b", teamToken: "y" },
    ],
  };
  const names = t.migrateTeamsData(container).teams.map((x) => x.name);
  expect(new Set(names).size).toBe(2);
  expect(names).toContain("dev");
  expect(names).toContain("dev-2");
});

test("add / list / use / read / remove across multiple teams", () => {
  reset();
  const a = t.addTeam({ serverUrl: "http://a", teamToken: "ta", teamName: "Alpha" });
  const b = t.addTeam({ serverUrl: "http://b", teamToken: "tb", teamName: "Beta" });
  expect(a).toBe("alpha");
  expect(b).toBe("beta");

  // Adding made Beta current; list reflects both.
  expect(t.currentTeamName()).toBe("beta");
  const list = t.listTeams();
  expect(list).toHaveLength(2);
  expect(list.find((x) => x.name === "beta")!.current).toBe(true);
  expect(list.find((x) => x.name === "alpha")!.current).toBe(false);

  // Default read = current (Beta); named read reaches the other.
  expect(t.readTeamConfig()!.teamToken).toBe("tb");
  expect(t.readTeamConfig("alpha")!.teamToken).toBe("ta");

  // Switch current.
  expect(t.useTeam("alpha")).toBe(true);
  expect(t.readTeamConfig()!.teamToken).toBe("ta");
  expect(t.useTeam("nope")).toBe(false);

  // A cursor update to the named team persists to the right record only.
  t.writeTeamConfig({ ...t.readTeamConfig("beta")!, usageCursor: 9 } as any, "beta");
  expect(t.readTeamConfig("beta")!.usageCursor).toBe(9);
  expect(t.readTeamConfig("alpha")!.usageCursor).toBeUndefined();

  // Leaving current (Alpha) drops it and repoints current to the survivor.
  expect(t.clearTeam()).toBe(true);
  expect(t.listTeams()).toHaveLength(1);
  expect(t.currentTeamName()).toBe("beta");
});

test("per-team passphrases are isolated in the keychain", () => {
  reset();
  t.addTeam({ serverUrl: "http://a", teamToken: "ta", teamName: "Alpha" });
  t.addTeam({ serverUrl: "http://b", teamToken: "tb", teamName: "Beta" }); // current = beta
  t.setTeamPassphrase("key-for-beta"); // no handle → current (beta)
  t.setTeamPassphrase("key-for-alpha", "alpha");
  expect(t.getTeamPassphrase("beta")).toBe("key-for-beta");
  expect(t.getTeamPassphrase("alpha")).toBe("key-for-alpha");
  expect(t.getTeamPassphrase()).toBe("key-for-beta"); // current
  // Leaving Beta removes its key; Alpha's is untouched.
  t.clearTeam("beta");
  expect(t.getTeamPassphrase("alpha")).toBe("key-for-alpha");
});

test("legacy single-team file + shared passphrase migrate on ensureTeamsMigrated", () => {
  reset();
  // Hand-write a legacy file and stash a passphrase under the old shared ref.
  writeFileSync(CFG, JSON.stringify({ serverUrl: "http://s", teamToken: "tok", teamId: 7, teamName: "Legacy Team" }));
  t.setTeamPassphrase("legacy-key"); // current is null here → shared ref
  t.ensureTeamsMigrated();
  // File is now a container with the one team current.
  expect(t.currentTeamName()).toBe("legacy-team");
  expect(t.listTeams()).toHaveLength(1);
  // The passphrase followed to the per-team ref.
  expect(t.getTeamPassphrase("legacy-team")).toBe("legacy-key");
});
