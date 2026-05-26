// `stm uninstall` tests — v0.8.0.
//
// planUninstall is a pure inspector — it never modifies state. We
// can test it freely against a sandboxed STM_DB. executeUninstall
// actually deletes things; we point it at a sandbox keychain service
// and a tmp DB path so it can't touch real data.

import { test, expect, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { planUninstall, executeUninstall, formatPlan, formatResult } from "../src/uninstall.ts";

const KC = `subscribetome-test-uninst-${process.pid}`;
process.env.STM_KEYCHAIN_SERVICE = KC;

const TMP = tmpdir();
const DB = join(TMP, `stm-uninst-${process.pid}.sqlite`);

const isDarwin = process.platform === "darwin";
const t = isDarwin ? test : test.skip;

afterAll(() => {
  for (const p of [DB, DB + "-shm", DB + "-wal"]) {
    try {
      rmSync(p);
    } catch {
      /* ignore */
    }
  }
  for (let i = 0; i < 50; i++) {
    try {
      execFileSync("/usr/bin/security", ["delete-generic-password", "-s", KC], {
        stdio: "ignore",
      });
    } catch {
      break;
    }
  }
});

t("planUninstall reports zero refs when DB is missing", () => {
  // Use a path we know doesn't exist.
  const plan = planUninstall({
    dbPath: join(TMP, `stm-uninst-missing-${Math.random()}.sqlite`),
  });
  expect(plan.keyRefs).toEqual([]);
  // Should still report the keystore name + paths (db doesn't add a
  // path since it doesn't exist).
  expect(plan.keystoreName).toBeTruthy();
});

t("planUninstall surfaces active keys from the inventory", () => {
  const env = process.env.STM_DB;
  process.env.STM_DB = DB;
  try {
    const store = new Store(DB);
    try {
      store.addKey({ tool: "openai", label: "uninst-a", value: "x" });
      store.addKey({ tool: "openai", label: "uninst-b", value: "y" });
    } finally {
      store.close();
    }
    const plan = planUninstall({ dbPath: DB });
    expect(plan.keyRefs.length).toBe(2);
    // refs are UUIDs — confirm they look like UUIDs.
    expect(plan.keyRefs[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.paths.some((p) => p.kind === "db")).toBe(true);
  } finally {
    if (env) process.env.STM_DB = env;
    else delete process.env.STM_DB;
  }
});

t("planUninstall skips revoked keys", () => {
  const env = process.env.STM_DB;
  process.env.STM_DB = DB;
  try {
    rmSync(DB, { force: true });
    const store = new Store(DB);
    try {
      store.addKey({ tool: "openai", label: "revoked-key", value: "x" });
      store.revokeKey("openai", "revoked-key");
      store.addKey({ tool: "openai", label: "active-key", value: "y" });
    } finally {
      store.close();
    }
    const plan = planUninstall({ dbPath: DB });
    // Only the active one should be listed for keystore deletion.
    expect(plan.keyRefs.length).toBe(1);
  } finally {
    if (env) process.env.STM_DB = env;
    else delete process.env.STM_DB;
  }
});

t("formatPlan includes the keystore name + key count + paths", () => {
  const plan = planUninstall({
    dbPath: join(TMP, `stm-uninst-missing-${Math.random()}.sqlite`),
  });
  const formatted = formatPlan(plan);
  expect(formatted).toMatch(/stm uninstall/);
  expect(formatted).toMatch(/keystore|Keychain|Secret Service|file/i);
  expect(formatted).toMatch(/plugin uninstall stm/);
});

t("executeUninstall removes inventory + active keys round-trip", () => {
  const env = process.env.STM_DB;
  process.env.STM_DB = DB;
  try {
    // Clean slate — previous tests in this file may have left behind
    // keystore entries under KC (revoked keys, etc). We assert
    // executeUninstall removes what IT was told to, not whatever
    // accumulated.
    for (let i = 0; i < 50; i++) {
      try {
        execFileSync("/usr/bin/security", ["delete-generic-password", "-s", KC], {
          stdio: "ignore",
        });
      } catch {
        break;
      }
    }
    rmSync(DB, { force: true });
    const store = new Store(DB);
    let refs: string[] = [];
    try {
      const k1 = store.addKey({ tool: "openai", label: "x1", value: "v1" });
      const k2 = store.addKey({ tool: "anthropic", label: "x2", value: "v2" });
      // We don't have the raw ref via KeyView, but we can verify by
      // resolving the values — they should exist BEFORE uninstall and
      // be gone AFTER.
      expect(store.resolve("openai", "x1")).toBe("v1");
      expect(store.resolve("anthropic", "x2")).toBe("v2");
    } finally {
      store.close();
    }

    const plan = planUninstall({ dbPath: DB });
    expect(plan.keyRefs.length).toBe(2);

    const result = executeUninstall(plan);
    expect(result.keysDeleted).toBe(2);
    expect(result.keysFailed).toEqual([]);

    // DB file should be gone now.
    expect(existsSync(DB)).toBe(false);

    // Verify via /usr/bin/security that no entries remain under our KC.
    let remaining = 0;
    for (let i = 0; i < 5; i++) {
      try {
        execFileSync("/usr/bin/security", ["find-generic-password", "-s", KC], {
          stdio: "ignore",
        });
        remaining++;
      } catch {
        break;
      }
    }
    expect(remaining).toBe(0);
  } finally {
    if (env) process.env.STM_DB = env;
    else delete process.env.STM_DB;
  }
});

t("executeUninstall is idempotent — second run is a no-op", () => {
  const env = process.env.STM_DB;
  process.env.STM_DB = DB;
  try {
    rmSync(DB, { force: true });
    // No keys yet; plan should be empty.
    const plan = planUninstall({ dbPath: DB });
    expect(plan.keyRefs.length).toBe(0);
    const result = executeUninstall(plan);
    expect(result.keysDeleted).toBe(0);
    expect(result.pathsDeleted.length).toBeLessThanOrEqual(1); // empty data dir maybe
  } finally {
    if (env) process.env.STM_DB = env;
    else delete process.env.STM_DB;
  }
});

t("formatResult includes the 'run /plugin uninstall stm' reminder", () => {
  const r = formatResult({
    keysDeleted: 3,
    keysFailed: [],
    pathsDeleted: ["/tmp/foo"],
    pathsFailed: [],
    codexHooksRemoved: false,
    codexMcpRemoved: false,
  });
  expect(r).toMatch(/plugin uninstall stm/);
  expect(r).toMatch(/removed 3 keys/);
});
