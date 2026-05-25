// EncryptedFile backend tests — Tier 3 (v0.6.0).
//
// File format + crypto are tested independently of the KeyStore
// surface so we know each layer is sound. Then a few end-to-end
// tests via the KeyStore interface confirm the integration.
//
// Critical assertions:
//   - Wrong passphrase throws a CLEAR error (not silent corruption).
//   - File magic + KDF id are checked on read; old/foreign files are
//     rejected with a meaningful error.
//   - File on disk is mode 0600.
//   - get() with no available passphrase returns null (hook fail-safe
//     contract, NOT a throw).

import { test, expect, beforeEach, afterAll } from "bun:test";
import {
  encryptVault,
  decryptVault,
  createEncryptedFileKeyStore,
  defaultEncryptedFilePath,
  encryptedFileExists,
  rotatePassphrase,
  inspectEncryptedFile,
  setCachedPassphrase,
  clearPassphraseCache,
} from "../src/keystores/encrypted-file.ts";
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "stm-encfile-"));
let counter = 0;
function newPath(): string {
  return join(ROOT, `keys-${counter++}.enc`);
}

beforeEach(() => clearPassphraseCache());
afterAll(() => {
  clearPassphraseCache();
  try { rmSync(ROOT, { recursive: true }); } catch { /* ignore */ }
});

// ---- crypto-level (encryptVault / decryptVault) -------------------------

test("encryptVault + decryptVault round-trip the same plaintext", () => {
  const pt = JSON.stringify({ a: "alpha", b: "bravo" });
  const enc = encryptVault(pt, "pass");
  expect(decryptVault(enc, "pass")).toBe(pt);
});

test("decryptVault with wrong passphrase throws a CLEAR error (no silent corruption)", () => {
  const enc = encryptVault('{"k":"v"}', "right");
  expect(() => decryptVault(enc, "wrong")).toThrow(/decryption failed/);
});

test("decryptVault rejects a file with bad magic bytes", () => {
  const bad = Buffer.from("notmagic" + "x".repeat(100));
  expect(() => decryptVault(bad, "anything")).toThrow(/magic mismatch/);
});

test("decryptVault rejects a file with an unknown KDF id (forward-compat door)", () => {
  // Write an stm header but with an unsupported KDF id (0x99 — reserved
  // for some future scheme we haven't shipped).
  const enc = encryptVault('{"k":"v"}', "pass");
  const tampered = Buffer.from(enc);
  tampered[8] = 0x99; // KDF id byte
  expect(() => decryptVault(tampered, "pass")).toThrow(/KDF id 153/);
});

test("decryptVault rejects a file that's too short to even contain a tag", () => {
  expect(() => decryptVault(Buffer.alloc(10), "pass")).toThrow(/too small/);
});

test("encryptVault produces a different ciphertext every call (random salt + iv)", () => {
  const a = encryptVault('{"k":"v"}', "p");
  const b = encryptVault('{"k":"v"}', "p");
  expect(Buffer.compare(a, b)).not.toBe(0);
});

// ---- KeyStore-level (createEncryptedFileKeyStore) -----------------------

test("set + get round-trips through a real file on disk", () => {
  const path = newPath();
  const ks = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => "p",
  });
  ks.set("r1", "value-one");
  expect(ks.get("r1")).toBe("value-one");
});

test("get() with no passphrase available returns null (hook fail-safe contract)", () => {
  const path = newPath();
  // Seed the file with a known passphrase
  const ks1 = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => "real-pass",
  });
  ks1.set("r", "v");
  // Now construct a backend whose provider can't yield a passphrase
  // — the hook fail-safe contract says GET returns null instead of
  // throwing, so PreToolUse exits 0 without rewriting.
  const ks2 = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => null,
  });
  expect(ks2.get("r")).toBeNull();
});

test("get() with a wrong passphrase returns null too (still fail-safe)", () => {
  const path = newPath();
  const ks1 = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => "right",
  });
  ks1.set("r", "v");
  const ks2 = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => "wrong",
  });
  expect(ks2.get("r")).toBeNull();
});

test("set() with no passphrase throws (write path is allowed to fail loudly)", () => {
  const path = newPath();
  const ks = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => null,
  });
  expect(() => ks.set("r", "v")).toThrow(/no passphrase/);
});

test("delete is idempotent (and silent on missing passphrase)", () => {
  const path = newPath();
  const ks1 = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => "p",
  });
  ks1.set("r", "v");
  ks1.delete("r");
  expect(ks1.get("r")).toBeNull();
  // Idempotent — deleting again is a no-op
  expect(() => ks1.delete("r")).not.toThrow();
  // And under a null provider, delete is silently a no-op
  const ks2 = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => null,
  });
  expect(() => ks2.delete("never-existed")).not.toThrow();
});

test("vault file is written with mode 0600", () => {
  const path = newPath();
  const ks = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => "p",
  });
  ks.set("r", "v");
  const mode = statSync(path).mode & 0o777;
  // Spec invariant: no group / world bits set.
  expect(mode & 0o077).toBe(0);
});

test("set persists across backend instances (file IS the consent)", () => {
  const path = newPath();
  const ks1 = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => "p",
  });
  ks1.set("r", "v");
  // Fresh instance, same path + passphrase → sees the value.
  const ks2 = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => "p",
  });
  expect(ks2.get("r")).toBe("v");
});

test("multiple entries coexist without cross-contamination", () => {
  const path = newPath();
  const ks = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => "p",
  });
  ks.set("a", "alpha");
  ks.set("b", "bravo");
  ks.set("c", "charlie");
  ks.delete("b");
  expect(ks.get("a")).toBe("alpha");
  expect(ks.get("b")).toBeNull();
  expect(ks.get("c")).toBe("charlie");
});

// ---- shared in-memory passphrase cache ----------------------------------

test("setCachedPassphrase pre-warms the cache; defaultPassphraseProvider reads it", () => {
  // Pure cache test — clearing first, then setting, then reading.
  // The default provider is a closure that consults the module-scoped
  // cache, so we test indirectly via the cache helpers.
  clearPassphraseCache();
  setCachedPassphrase("cached-value");
  // Construct a backend WITHOUT passing a provider — the default
  // provider should find the cached value.
  const path = newPath();
  const ks = createEncryptedFileKeyStore({ filePath: path });
  ks.set("r", "v");
  // If the cache wasn't used, set() would have thrown "no passphrase".
  expect(ks.get("r")).toBe("v");
  clearPassphraseCache();
});

// ---- inspectEncryptedFile -----------------------------------------------

test("inspectEncryptedFile reports magic, mode, kdf-id, size on a real file", () => {
  const path = newPath();
  const ks = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => "p",
  });
  ks.set("r", "v");
  const ins = inspectEncryptedFile(path);
  expect(ins.exists).toBe(true);
  expect(ins.magicOK).toBe(true);
  expect(ins.modeOK).toBe(true);
  expect(ins.kdfId).toBe(1);
  expect(ins.size).toBeGreaterThan(37); // header overhead
});

test("inspectEncryptedFile is honest when the file doesn't exist", () => {
  const ins = inspectEncryptedFile(join(ROOT, "no-such-vault.enc"));
  expect(ins.exists).toBe(false);
  expect(ins.modeOK).toBe(false);
  expect(ins.magicOK).toBe(false);
  expect(ins.kdfId).toBeNull();
});

test("inspectEncryptedFile flags a foreign file (wrong magic)", () => {
  const path = newPath();
  writeFileSync(path, "this is not an stm vault\n", { mode: 0o600 });
  const ins = inspectEncryptedFile(path);
  expect(ins.exists).toBe(true);
  expect(ins.magicOK).toBe(false);
});

// ---- rotatePassphrase ---------------------------------------------------

test("rotatePassphrase: old → new, leaves a .bak.<ts>, new passphrase decrypts", () => {
  const path = newPath();
  const ks1 = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => "old-pass",
  });
  ks1.set("r", "v");
  const bak = rotatePassphrase({
    filePath: path,
    oldPassphrase: "old-pass",
    newPassphrase: "new-pass",
    now: () => 12345,
  });
  expect(bak).toBe(`${path}.bak.12345`);
  expect(existsSync(bak!)).toBe(true);
  // Old backup decrypts under OLD passphrase
  expect(decryptVault(readFileSync(bak!), "old-pass")).toContain("v");
  // New file decrypts under NEW passphrase
  const ks2 = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => "new-pass",
  });
  expect(ks2.get("r")).toBe("v");
});

test("rotatePassphrase on a missing file creates a fresh empty vault under the new pass", () => {
  const path = newPath();
  expect(encryptedFileExists(path)).toBe(false);
  const bak = rotatePassphrase({
    filePath: path,
    oldPassphrase: "doesnt-matter",
    newPassphrase: "new-pass",
  });
  expect(bak).toBeNull();
  expect(encryptedFileExists(path)).toBe(true);
  // Decrypting under the new pass produces an empty JSON object
  const ks = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => "new-pass",
  });
  expect(ks.get("anything")).toBeNull(); // empty map
});

test("rotatePassphrase with the wrong old passphrase throws BEFORE touching the file", () => {
  const path = newPath();
  const ks = createEncryptedFileKeyStore({
    filePath: path,
    passphraseProvider: () => "real-pass",
  });
  ks.set("r", "v");
  const before = readFileSync(path);
  expect(() =>
    rotatePassphrase({
      filePath: path,
      oldPassphrase: "wrong-pass",
      newPassphrase: "new-pass",
    }),
  ).toThrow(/decryption failed/);
  // File should be unchanged
  expect(Buffer.compare(before, readFileSync(path))).toBe(0);
});

// ---- defaultEncryptedFilePath -------------------------------------------

test("defaultEncryptedFilePath returns an absolute path under XDG_DATA_HOME if set", () => {
  // The function reads process.env at call time, so we set + reset.
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = "/custom/xdg";
  try {
    expect(defaultEncryptedFilePath()).toBe("/custom/xdg/subscribetome/keys.enc");
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
  }
});

test("defaultEncryptedFilePath falls back to ~/.local/share when XDG_DATA_HOME is unset/invalid", () => {
  const prev = process.env.XDG_DATA_HOME;
  delete process.env.XDG_DATA_HOME;
  try {
    const p = defaultEncryptedFilePath();
    expect(p.endsWith("/.local/share/subscribetome/keys.enc")).toBe(true);
  } finally {
    if (prev !== undefined) process.env.XDG_DATA_HOME = prev;
  }
});
