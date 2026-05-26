// Encrypted vault snapshot tests — v0.8.0.
//
// Round-trips an inventory + keystore through export → import. The
// "active keystore" is the real one (macOS Keychain on this host),
// scoped to a unique sandbox service so a CI run doesn't corrupt
// production entries.

import { test, expect, afterAll, beforeEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import {
  exportSnapshot,
  importSnapshot,
  inspectSnapshot,
  SNAPSHOT_FORMAT_VERSION,
} from "../src/vault-snapshot.ts";
import { decryptVault } from "../src/keystores/encrypted-file.ts";

const KC = `subscribetome-test-snap-${process.pid}`;
process.env.STM_KEYCHAIN_SERVICE = KC;

const TMP = tmpdir();
const DB1 = join(TMP, `stm-snap-src-${process.pid}.sqlite`);
const DB2 = join(TMP, `stm-snap-dst-${process.pid}.sqlite`);
const SNAP = join(TMP, `stm-snap-${process.pid}.enc`);

const isDarwin = process.platform === "darwin";
const t = isDarwin ? test : test.skip;

afterAll(() => {
  for (const p of [DB1, DB2, SNAP]) {
    try {
      rmSync(p);
    } catch {
      /* ignore */
    }
    for (const ext of ["-shm", "-wal"]) {
      try {
        rmSync(p + ext);
      } catch {
        /* ignore */
      }
    }
  }
  // Sweep any .bak.* siblings the import path may have created.
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

t("buildSnapshot refuses to export when the DB doesn't exist yet", () => {
  expect(() =>
    exportSnapshot({
      outPath: SNAP,
      passphrase: "test-passphrase",
      dbPath: join(TMP, `stm-snap-missing-${process.pid}.sqlite`),
    }),
  ).toThrow(/no inventory database/);
});

t("export → import round-trips inventory + keys", () => {
  const src = new Store(DB1);
  try {
    src.addKey({
      tool: "openai",
      label: "default",
      value: "test-value-alpha-" + Math.random().toString(36).slice(2),
    });
    src.addKey({
      tool: "anthropic",
      label: "default",
      value: "test-value-beta-" + Math.random().toString(36).slice(2),
    });
    src.upsertTool({
      name: "stripe",
      displayName: "Stripe",
      monthlyCost: 0,
    });
  } finally {
    src.close();
  }

  // Capture the secrets we just wrote so we can assert after restore.
  const src2 = new Store(DB1);
  const openaiSecret = src2.resolve("openai", "default");
  const anthSecret = src2.resolve("anthropic", "default");
  src2.close();
  expect(openaiSecret).toBeTruthy();
  expect(anthSecret).toBeTruthy();

  // Export.
  const result = exportSnapshot({
    outPath: SNAP,
    passphrase: "hunter2",
    dbPath: DB1,
  });
  expect(result.keysExported).toBe(2);
  expect(existsSync(SNAP)).toBe(true);

  // Move DB1 out of the way and "restore" into DB2.
  rmSync(DB1);
  const restored = importSnapshot({
    inPath: SNAP,
    passphrase: "hunter2",
    dbPath: DB2,
  });
  expect(restored.keysRestored).toBe(2);
  expect(restored.stmVersion).toBeTruthy();

  // Read back via a fresh Store pointed at DB2 — values must match.
  const dst = new Store(DB2);
  try {
    expect(dst.resolve("openai", "default")).toBe(openaiSecret);
    expect(dst.resolve("anthropic", "default")).toBe(anthSecret);
    expect(dst.getTool("stripe")?.name).toBe("stripe");
  } finally {
    dst.close();
  }
});

t("export file is encrypted (raw bytes don't contain secret)", () => {
  const src = new Store(DB1);
  const secret = "very-distinct-secret-" + Math.random().toString(36).slice(2);
  try {
    src.addKey({ tool: "openai", label: "leakcheck", value: secret });
  } finally {
    src.close();
  }
  exportSnapshot({ outPath: SNAP, passphrase: "pw", dbPath: DB1 });
  const raw = readFileSync(SNAP);
  expect(raw.toString("latin1").includes(secret)).toBe(false);
  // But decrypting under the right passphrase exposes it (inside the
  // JSON, base64'd via the SQLite blob OR inline as a secrets entry).
  const dec = decryptVault(raw, "pw");
  expect(dec.includes(secret)).toBe(true);
});

t("export file mode is 0600 (POSIX only)", () => {
  if (process.platform === "win32") return;
  const src = new Store(DB1);
  try {
    src.addKey({ tool: "openai", label: "mode", value: "x" });
  } finally {
    src.close();
  }
  exportSnapshot({ outPath: SNAP, passphrase: "pw", dbPath: DB1 });
  const st = statSync(SNAP);
  // u=rw, no group/other bits set.
  expect(st.mode & 0o077).toBe(0);
});

t("import rejects wrong passphrase with a clear error", () => {
  const src = new Store(DB1);
  try {
    src.addKey({ tool: "openai", label: "wrongpp", value: "x" });
  } finally {
    src.close();
  }
  exportSnapshot({ outPath: SNAP, passphrase: "correct", dbPath: DB1 });
  expect(() =>
    importSnapshot({ inPath: SNAP, passphrase: "wrong", dbPath: DB2 }),
  ).toThrow(/decryption failed|wrong passphrase|tampered/);
});

t("import refuses snapshot with unknown format version", () => {
  // Hand-craft a snapshot JSON with a bogus version, encrypt it under
  // the same primitive, write it out, and confirm import bails.
  const fakeSnap = {
    stmVaultSnapshot: "999",
    exportedAt: new Date().toISOString(),
    stmVersion: "test",
    hostname: "test",
    db: Buffer.from("").toString("base64"),
    secrets: {},
  };
  const { encryptVault } = require("../src/keystores/encrypted-file.ts");
  const bytes = encryptVault(JSON.stringify(fakeSnap), "pw");
  const { writeFileSync } = require("node:fs");
  writeFileSync(SNAP, bytes);
  expect(() =>
    importSnapshot({ inPath: SNAP, passphrase: "pw", dbPath: DB2 }),
  ).toThrow(/format version 999 not recognised|upgrade stm/);
});

t("import backs up the existing DB to <path>.bak.<ts>", () => {
  // Step 1: build a snapshot from DB1.
  const src = new Store(DB1);
  try {
    src.addKey({ tool: "openai", label: "backup-test", value: "v1" });
  } finally {
    src.close();
  }
  exportSnapshot({ outPath: SNAP, passphrase: "pw", dbPath: DB1 });

  // Step 2: put a different DB at DB2 (so import has something to
  // back up) and restore over it.
  const pre = new Store(DB2);
  try {
    pre.upsertTool({ name: "preexisting", displayName: "Preexisting" });
  } finally {
    pre.close();
  }
  const restored = importSnapshot({
    inPath: SNAP,
    passphrase: "pw",
    dbPath: DB2,
  });
  expect(restored.dbBackedUpTo).toMatch(/\.bak\.\d+$/);
  expect(existsSync(restored.dbBackedUpTo!)).toBe(true);
  // Cleanup
  rmSync(restored.dbBackedUpTo!);
});

t("inspectSnapshot reports magic OK for a real export", () => {
  const src = new Store(DB1);
  try {
    src.addKey({ tool: "openai", label: "inspect", value: "x" });
  } finally {
    src.close();
  }
  exportSnapshot({ outPath: SNAP, passphrase: "pw", dbPath: DB1 });
  const info = inspectSnapshot(SNAP);
  expect(info.exists).toBe(true);
  expect(info.magicOK).toBe(true);
  expect(info.size).toBeGreaterThan(0);
});

t("inspectSnapshot returns exists:false for missing file", () => {
  const info = inspectSnapshot(join(TMP, `stm-snap-nope-${Math.random()}.enc`));
  expect(info.exists).toBe(false);
});

t("SNAPSHOT_FORMAT_VERSION is exported (drift insurance)", () => {
  expect(SNAPSHOT_FORMAT_VERSION).toBe("1");
});
