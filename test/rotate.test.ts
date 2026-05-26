// Store.rotateKey tests — v0.9.0.
//
// Rotation is an atomic in-place value swap behind a stable
// placeholder. The placeholder {{stm:tool:label}} is unchanged;
// every existing hook flow keeps working; the value behind it is
// different. Tests cover happy path + the rollback contract.

import { test, expect, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";

const KC = `subscribetome-test-rotate-${process.pid}`;
process.env.STM_KEYCHAIN_SERVICE = KC;
const DB = join(tmpdir(), `stm-rotate-${process.pid}.sqlite`);
process.env.STM_DB = DB;

const isDarwin = process.platform === "darwin";
const t = isDarwin ? test : test.skip;

afterAll(() => {
  for (const ext of ["", "-shm", "-wal"]) {
    try {
      rmSync(DB + ext);
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

t("rotateKey swaps the value behind a placeholder atomically", () => {
  const store = new Store(DB);
  try {
    store.addKey({ tool: "openai", label: "rot-1", value: "old-value" });
    expect(store.resolve("openai", "rot-1")).toBe("old-value");

    const result = store.rotateKey({
      tool: "openai",
      label: "rot-1",
      newValue: "new-value",
    });
    expect(result.newRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.oldRefDeleted).toBe(true);

    // Placeholder address is unchanged — resolve still goes through
    // the SAME (tool, label) and now returns the NEW value.
    expect(store.resolve("openai", "rot-1")).toBe("new-value");
  } finally {
    store.close();
  }
});

t("rotateKey throws when (tool, label) doesn't exist", () => {
  const store = new Store(DB);
  try {
    expect(() =>
      store.rotateKey({
        tool: "openai",
        label: "does-not-exist",
        newValue: "x",
      }),
    ).toThrow(/no key labelled/);
  } finally {
    store.close();
  }
});

t("rotateKey throws on empty new value", () => {
  const store = new Store(DB);
  try {
    store.addKey({ tool: "openai", label: "rot-empty", value: "v" });
    expect(() =>
      store.rotateKey({
        tool: "openai",
        label: "rot-empty",
        newValue: "",
      }),
    ).toThrow(/new key value is empty/);
  } finally {
    store.close();
  }
});

t("rotateKey preserves the placeholder address through multiple rotations", () => {
  const store = new Store(DB);
  try {
    store.addKey({ tool: "openai", label: "rot-multi", value: "v0" });
    const view = store.viewKey("openai", "rot-multi")!;
    const ph = view.placeholder;
    for (let i = 1; i <= 5; i++) {
      store.rotateKey({
        tool: "openai",
        label: "rot-multi",
        newValue: `v${i}`,
      });
      // Placeholder string stays identical.
      expect(store.viewKey("openai", "rot-multi")!.placeholder).toBe(ph);
      // Value matches the latest rotation.
      expect(store.resolve("openai", "rot-multi")).toBe(`v${i}`);
    }
  } finally {
    store.close();
  }
});

t("rotateKey succeeds even when the old keystore entry is already gone", () => {
  // Simulate "user wiped the keychain by hand": add a key, delete the
  // underlying keystore entry, then rotate. The inventory still has
  // the row pointing at a ref that's no longer in the keystore;
  // rotate should still succeed cleanly. keychainDelete is idempotent
  // (silent on absent) so oldRefDeleted comes back true regardless —
  // the contract is "we tried to clean up the old entry without
  // throwing", not "an entry was actually present to delete."
  const store = new Store(DB);
  try {
    store.addKey({ tool: "openai", label: "rot-orphan", value: "v" });
    const ref = (store as any).db
      .query(
        `SELECT k.keychain_ref AS ref FROM keys k JOIN tools t ON t.id = k.tool_id WHERE t.name = ? AND k.label = ?`,
      )
      .get("openai", "rot-orphan").ref as string;
    execFileSync(
      "/usr/bin/security",
      ["delete-generic-password", "-s", KC, "-a", ref],
      { stdio: "ignore" },
    );
    const result = store.rotateKey({
      tool: "openai",
      label: "rot-orphan",
      newValue: "new",
    });
    // Rotation succeeded — the new value resolves cleanly. The
    // oldRefDeleted flag is true because keychainDelete is idempotent.
    expect(result.oldRefDeleted).toBe(true);
    expect(store.resolve("openai", "rot-orphan")).toBe("new");
  } finally {
    store.close();
  }
});

t("rotateKey marks a revoked key active again on rotation", () => {
  const store = new Store(DB);
  try {
    store.addKey({ tool: "openai", label: "rot-revived", value: "v" });
    store.revokeKey("openai", "rot-revived");
    expect(store.viewKey("openai", "rot-revived")!.status).toBe("revoked");
    // The CLI rotateCmd refuses to rotate a revoked key — but the
    // store-level method allows it (e.g. for an import flow that
    // restores a revoked-then-rotated entry). Confirm the status
    // flips back to active.
    store.rotateKey({
      tool: "openai",
      label: "rot-revived",
      newValue: "fresh",
    });
    expect(store.viewKey("openai", "rot-revived")!.status).toBe("active");
    expect(store.resolve("openai", "rot-revived")).toBe("fresh");
  } finally {
    store.close();
  }
});
