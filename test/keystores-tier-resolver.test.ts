// Tier resolver tests — v0.6.0 Linux fallback chain.
//
// Most resolver tests live in test/keystores.test.ts; this file
// focuses on the cross-tier matrix: which combinations select which
// backend, and the "never silently fall back to plaintext" invariant.

import { test, expect, beforeEach, afterAll } from "bun:test";
import {
  selectKeyStore,
  _resetKeyStoreCache,
} from "../src/keystores/index.ts";
import type { SpawnFn } from "../src/keystores/types.ts";
import { clearPassphraseCache } from "../src/keystores/encrypted-file.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeEach(() => {
  _resetKeyStoreCache();
  clearPassphraseCache();
});
afterAll(() => {
  _resetKeyStoreCache();
  clearPassphraseCache();
});

const ROOT = mkdtempSync(join(tmpdir(), "stm-tier-"));
let counter = 0;
function tmpVault(): string {
  return join(ROOT, `vault-${counter++}.enc`);
}

function recordingSpawn(
  responses: Array<{ status: number; stdout?: string; stderr?: string }>,
): { spawn: SpawnFn } {
  let idx = 0;
  const spawn: SpawnFn = (_cmd, _args, _opts) => {
    const r = responses[idx] ?? { status: 0, stdout: "", stderr: "" };
    idx++;
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { spawn };
}

// ---- Tier 1 picked when reachable ---------------------------------------

test("Tier 1 (SecretService) is picked when libsecret + D-Bus probe both succeed", () => {
  const { spawn } = recordingSpawn([{ status: 1 /* SS probe: 1 = not-found = OK */ }]);
  const ks = selectKeyStore({
    force: true,
    platform: "linux",
    env: {},
    spawn,
    which: (b) => b === "secret-tool", // pass NOT on PATH
  });
  expect(ks.describe()).toBe("Linux Secret Service (libsecret)");
});

// ---- Fall through to Tier 2 ---------------------------------------------

test("Tier 2 (pass) is picked when Tier 1 fails AND pass is reachable", () => {
  const { spawn } = recordingSpawn([
    { status: 127 }, // SS probe fails (D-Bus unreachable)
    { status: 0 },   // pass version OK
    { status: 0 },   // pass ls OK
  ]);
  const ks = selectKeyStore({
    force: true,
    platform: "linux",
    env: {},
    spawn,
    which: () => true, // both binaries on PATH
  });
  expect(ks.describe()).toBe("Linux Pass (pass + GPG)");
});

// ---- Fall through to Tier 3 (opt-in) ------------------------------------

test("Tier 3 (EncryptedFile) is picked ONLY with STM_ALLOW_FILE_BACKEND=1 on first touch", () => {
  const { spawn } = recordingSpawn([
    { status: 127 }, // SS fail
    { status: 0 },   // pass version OK
    { status: 1 },   // pass ls fail (no GPG store)
  ]);
  const ks = selectKeyStore({
    force: true,
    platform: "linux",
    env: { STM_ALLOW_FILE_BACKEND: "1" },
    spawn,
    which: () => true,
    encryptedFilePath: tmpVault(),
    passphraseProvider: () => "test-pass",
  });
  expect(ks.describe()).toBe("EncryptedFile (0600, PBKDF2-SHA512)");
});

test("WITHOUT STM_ALLOW_FILE_BACKEND and no existing vault, Tier 3 is NOT picked silently", () => {
  // The gh-CLI cautionary tale: we refuse to silently degrade to a
  // weaker storage tier. Without explicit opt-in (env var) OR a
  // pre-existing vault, the resolver returns `unsupported (...)`.
  const { spawn } = recordingSpawn([
    { status: 127 }, // SS fail
    { status: 0 },   // pass version OK
    { status: 1 },   // pass ls fail
  ]);
  const ks = selectKeyStore({
    force: true,
    platform: "linux",
    env: {}, // no opt-in
    spawn,
    which: () => true,
    encryptedFilePath: join(ROOT, "no-such.enc"), // doesn't exist
  });
  expect(ks.describe()).toContain("Tier 3 (EncryptedFile)");
  expect(ks.describe()).toContain("opt-in");
  expect(() => ks.set("r", "v")).toThrow(/no usable keystore/);
});

test("Tier 3 is picked WITHOUT opt-in when the vault file already exists (existence IS consent)", () => {
  // First, opt in once to create the file.
  const path = tmpVault();
  const { spawn: spawn1 } = recordingSpawn([
    { status: 127 },
    { status: 0 },
    { status: 1 },
  ]);
  const ks1 = selectKeyStore({
    force: true,
    platform: "linux",
    env: { STM_ALLOW_FILE_BACKEND: "1" },
    spawn: spawn1,
    which: () => true,
    encryptedFilePath: path,
    passphraseProvider: () => "p",
  });
  ks1.set("r", "v"); // writes the file

  // Now WITHOUT the opt-in env, the file's existence is enough.
  const { spawn: spawn2 } = recordingSpawn([
    { status: 127 },
    { status: 0 },
    { status: 1 },
  ]);
  const ks2 = selectKeyStore({
    force: true,
    platform: "linux",
    env: {}, // no opt-in
    spawn: spawn2,
    which: () => true,
    encryptedFilePath: path,
    passphraseProvider: () => "p",
  });
  expect(ks2.describe()).toBe("EncryptedFile (0600, PBKDF2-SHA512)");
});

// ---- STM_KEYSTORE alias matrix ------------------------------------------

test("STM_KEYSTORE=linux-pass alias forces Tier 2 even when Tier 1 would have been reachable", () => {
  // We're on macOS in this test (platform: 'linux' is just a forced
  // selection), but the override should beat the platform default.
  const ks = selectKeyStore({
    force: true,
    platform: "linux",
    env: { STM_KEYSTORE: "linux-pass" },
  });
  expect(ks.describe()).toBe("Linux Pass (pass + GPG)");
});

test("STM_KEYSTORE=encrypted-file alias forces Tier 3 without the opt-in env var", () => {
  // The override IS the opt-in for the explicit-alias path.
  const ks = selectKeyStore({
    force: true,
    platform: "linux",
    env: { STM_KEYSTORE: "encrypted-file" },
    encryptedFilePath: tmpVault(),
    passphraseProvider: () => "test-pass",
  });
  expect(ks.describe()).toBe("EncryptedFile (0600, PBKDF2-SHA512)");
});

test("STM_KEYSTORE=file (short alias) also works", () => {
  const ks = selectKeyStore({
    force: true,
    platform: "linux",
    env: { STM_KEYSTORE: "file" },
    encryptedFilePath: tmpVault(),
    passphraseProvider: () => "test-pass",
  });
  expect(ks.describe()).toBe("EncryptedFile (0600, PBKDF2-SHA512)");
});

test("STM_KEYSTORE=pass alias works on any platform", () => {
  const ks = selectKeyStore({
    force: true,
    platform: "darwin", // override beats macOS default
    env: { STM_KEYSTORE: "pass" },
  });
  expect(ks.describe()).toBe("Linux Pass (pass + GPG)");
});

// ---- doctor report -------------------------------------------------------

test("doctorReport on darwin reports a single reachable tier", async () => {
  const { doctorReport } = await import("../src/doctor.ts");
  const r = doctorReport({ platform: "darwin" });
  expect(r.ok).toBe(true);
  expect(r.tiers.length).toBe(1);
  expect(r.activeTier?.name).toBe("macOS Keychain");
});

test("doctorReport on linux with no tier reachable returns ok=false + 3 tiers", async () => {
  const { doctorReport } = await import("../src/doctor.ts");
  const r = doctorReport({
    platform: "linux",
    env: {},
    which: () => false,
    encryptedFilePath: join(ROOT, "no-such.enc"),
  });
  expect(r.ok).toBe(false);
  expect(r.tiers.length).toBe(3);
  // Each tier has a concrete fix when not reachable.
  for (const t of r.tiers) {
    if (!t.reachable) {
      expect(t.reason).toBeDefined();
      expect(t.fix).toBeDefined();
    }
  }
});

test("doctorReport on linux with a vault file present picks Tier 3 as active", async () => {
  const path = tmpVault();
  // Seed a vault.
  const ks = selectKeyStore({
    force: true,
    platform: "linux",
    env: { STM_KEYSTORE: "encrypted-file" },
    encryptedFilePath: path,
    passphraseProvider: () => "p",
  });
  ks.set("r", "v");

  const { doctorReport } = await import("../src/doctor.ts");
  const r = doctorReport({
    platform: "linux",
    env: {},
    which: () => false,
    encryptedFilePath: path,
  });
  expect(r.ok).toBe(true);
  expect(r.activeTier?.tier).toBe(3);
});
