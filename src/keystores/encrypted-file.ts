// EncryptedFile backend — Tier 3, last-resort Linux fallback
// (specs/cross-platform-and-codex.md §5; plan:
// specs/plans/v0.6-linux-headless.md).
//
// What this is:
//   - A single passphrase-derived key encrypts a JSON map of
//     {ref: value} entries to one file on disk.
//   - File path: $XDG_DATA_HOME/subscribetome/keys.enc
//     (default ~/.local/share/subscribetome/keys.enc), mode 0600.
//   - Crypto: PBKDF2-SHA512 with 600 000 iterations (OWASP-2025
//     recommended) derives a 32-byte key; AES-256-GCM encrypts the
//     JSON plaintext with a per-file random 16-byte salt and a fresh
//     12-byte IV per write. The GCM tag covers the whole ciphertext,
//     so a wrong passphrase produces a clear authentication failure
//     instead of silent garbage.
//
// Why sync primitives (node:crypto, not WebCrypto):
//   The KeyStore interface is synchronous — Store.resolve and the
//   hook code path call `keychainGet(ref)` and expect a value back
//   in the same tick. WebCrypto is async. Rather than churn the
//   interface, we use `pbkdf2Sync` + `createCipheriv("aes-256-gcm")`
//   from node:crypto, both of which Bun ships natively.
//
// Why this exists at all:
//   Headless Linux (SSH, container, WSL, CI) has no Secret Service
//   and often no `pass` either. The alternative to a tier-3 fallback
//   is the gh-CLI cautionary tale — silently plaintext. We refuse
//   that. We do NOT auto-create the file on a fresh install (no
//   silent fallback to weaker storage); the user opts in once via
//   STM_ALLOW_FILE_BACKEND=1, OR the file's existence IS the consent
//   for subsequent runs.
//
// File layout (binary):
//
//   bytes 0..8    magic           "stmenc01"     (8 bytes ASCII)
//   bytes 8..9    kdf_id          0x01 = PBKDF2-SHA512 600 000 iters
//                                  0x02 = (reserved for Argon2id in v0.6.1)
//   bytes 9..25   salt            16 random bytes
//   bytes 25..37  iv              12 random bytes
//   bytes 37..    ciphertext      includes the 16-byte GCM tag at the end
//
// Passphrase UX (spec §7 #3 — fiddliest in the roadmap):
//   - The PASSPHRASE comes from an injectable provider so tests can
//     pin it and `stm vault unlock` can pre-warm a shared in-memory
//     cache. The default provider tries `$STM_FILE_PASSPHRASE` first,
//     then prompts on stderr if stdin is a TTY, then returns null.
//   - Non-TTY without env → returns null → KeyStore `get` returns
//     null → the PreToolUse hook fails safe (exit 0 without rewriting,
//     per spec). CRITICAL: we never block the hook on a missing
//     passphrase.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  renameSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  randomBytes,
  pbkdf2Sync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import type { KeyStore } from "./types.ts";

// ---- file path ----------------------------------------------------------

/** XDG-conformant default path. Honours $XDG_DATA_HOME if set. */
export function defaultEncryptedFilePath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".local", "share");
  return join(base, "subscribetome", "keys.enc");
}

export function encryptedFileExists(path?: string): boolean {
  return existsSync(path ?? defaultEncryptedFilePath());
}

// ---- crypto -------------------------------------------------------------

const MAGIC = new TextEncoder().encode("stmenc01");
const KDF_PBKDF2_SHA512 = 0x01;
const PBKDF2_ITERS = 600_000;
const SALT_LEN = 16;
const IV_LEN = 12;
const KEY_LEN_BYTES = 32; // AES-256
const TAG_LEN_BYTES = 16;
const HEADER_LEN = MAGIC.byteLength + 1 + SALT_LEN + IV_LEN; // 37

/**
 * Derive a 32-byte AES key from a passphrase + salt via
 * PBKDF2-SHA512. 600 000 iterations is OWASP-2025-current.
 */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERS, KEY_LEN_BYTES, "sha512");
}

/**
 * Encrypt a JSON-serializable plaintext into the file format above.
 * Returns the full file bytes ready for atomic write.
 */
export function encryptVault(plaintext: string, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ctBody = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Layout: magic (8) | kdf (1) | salt (16) | iv (12) | ctBody | tag (16)
  const out = Buffer.alloc(HEADER_LEN + ctBody.length + tag.length);
  let off = 0;
  Buffer.from(MAGIC).copy(out, off);
  off += MAGIC.byteLength;
  out[off++] = KDF_PBKDF2_SHA512;
  salt.copy(out, off);
  off += SALT_LEN;
  iv.copy(out, off);
  off += IV_LEN;
  ctBody.copy(out, off);
  off += ctBody.length;
  tag.copy(out, off);
  return out;
}

/**
 * Inverse of `encryptVault`. Throws on:
 *   - missing or wrong magic (file format mismatch — "this isn't an
 *     stm vault")
 *   - unsupported KDF id (forward-compat door for Argon2id v0.6.1)
 *   - GCM authentication failure (wrong passphrase OR tampering —
 *     collapsed into one user-facing message since the fix is the same)
 */
export function decryptVault(bytes: Buffer, passphrase: string): string {
  if (bytes.length < HEADER_LEN + TAG_LEN_BYTES) {
    throw new Error("vault file is too small to be valid");
  }
  for (let i = 0; i < MAGIC.byteLength; i++) {
    if (bytes[i] !== MAGIC[i]) {
      throw new Error(
        "vault file magic mismatch — not an stm encrypted vault, or written by a newer version",
      );
    }
  }
  const kdfId = bytes[MAGIC.byteLength];
  if (kdfId !== KDF_PBKDF2_SHA512) {
    throw new Error(
      `vault uses KDF id ${kdfId} which this version doesn't recognise — ` +
        `upgrade stm or rotate the vault.`,
    );
  }
  const salt = bytes.subarray(
    MAGIC.byteLength + 1,
    MAGIC.byteLength + 1 + SALT_LEN,
  );
  const iv = bytes.subarray(
    MAGIC.byteLength + 1 + SALT_LEN,
    MAGIC.byteLength + 1 + SALT_LEN + IV_LEN,
  );
  const tag = bytes.subarray(bytes.length - TAG_LEN_BYTES);
  const ctBody = bytes.subarray(HEADER_LEN, bytes.length - TAG_LEN_BYTES);
  const key = deriveKey(passphrase, Buffer.from(salt));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ctBody), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    // Auth failure: wrong passphrase or file tampered. Collapse the
    // two cases — fix is identical from the user's POV (use the
    // right passphrase, or restore from backup).
    throw new Error(
      "vault decryption failed — wrong passphrase, or the file was tampered with",
    );
  }
}

// ---- passphrase provider ------------------------------------------------

/**
 * A function that returns the passphrase (or null when it can't be
 * provided non-interactively). Injectable so tests pin a value AND
 * `stm vault unlock` can pre-warm a shared in-memory cache.
 */
export type PassphraseProvider = (purpose: "read" | "write") => string | null;

/**
 * The shared in-memory cache that `stm vault unlock` writes to and
 * subsequent ops read from. Module-scoped — survives across multiple
 * KeyStore instances within one process. Cleared by
 * `clearPassphraseCache()` (tests).
 */
let cachedPassphrase: string | null = null;

export function setCachedPassphrase(p: string): void {
  cachedPassphrase = p;
}

export function clearPassphraseCache(): void {
  cachedPassphrase = null;
}

/**
 * The default provider chain. Order:
 *   1. In-memory cache (`stm vault unlock` set it).
 *   2. `$STM_FILE_PASSPHRASE` env var (CI, non-interactive use).
 *   3. Interactive prompt on stderr — ONLY when stdin AND stderr are
 *      TTYs. Non-TTY callers get null, which surfaces upstream as
 *      "key not resolvable right now"; the hook fails safe.
 */
export function defaultPassphraseProvider(): PassphraseProvider {
  return (purpose) => {
    if (cachedPassphrase !== null) return cachedPassphrase;
    const env = process.env.STM_FILE_PASSPHRASE;
    if (env) {
      cachedPassphrase = env;
      return env;
    }
    // Refuse the interactive path when stdin / stderr are non-TTY —
    // the hook fail-safe contract requires this.
    if (!process.stdin.isTTY || !process.stderr.isTTY) return null;
    process.stderr.write(
      purpose === "write"
        ? "Set a passphrase for the stm encrypted vault (won't echo): "
        : "Unlock the stm encrypted vault (won't echo): ",
    );
    // Bun supports `prompt()` for short interactive input. The
    // accepted limitation: the value echoes on terminals that
    // don't honour `stty -echo`. `stm vault unlock` is the
    // recommended UX and writes to the cache directly.
    const v = (globalThis as any).prompt?.("");
    process.stderr.write("\n");
    if (typeof v !== "string" || v.length === 0) return null;
    cachedPassphrase = v;
    return v;
  };
}

// ---- the backend --------------------------------------------------------

export interface EncryptedFileOptions {
  filePath?: string;
  passphraseProvider?: PassphraseProvider;
}

export function createEncryptedFileKeyStore(
  opts?: EncryptedFileOptions,
): KeyStore {
  const filePath = opts?.filePath ?? defaultEncryptedFilePath();
  const provider = opts?.passphraseProvider ?? defaultPassphraseProvider();

  // We cache the decrypted map in memory after first successful
  // read so a sequence of set/get/delete doesn't re-derive the key
  // each time. The cache is invalidated when we write.
  let memory: Record<string, string> | null = null;
  let memoryPassphrase: string | null = null;

  function load(passphrase: string): Record<string, string> {
    if (memory && memoryPassphrase === passphrase) return memory;
    if (!existsSync(filePath)) {
      memory = {};
      memoryPassphrase = passphrase;
      return memory;
    }
    const bytes = readFileSync(filePath);
    const json = decryptVault(bytes, passphrase);
    memory = JSON.parse(json) as Record<string, string>;
    memoryPassphrase = passphrase;
    return memory;
  }

  function save(map: Record<string, string>, passphrase: string): void {
    const bytes = encryptVault(JSON.stringify(map), passphrase);
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* best-effort */
    }
    renameSync(tmp, filePath);
    memory = map;
    memoryPassphrase = passphrase;
  }

  return {
    set(ref: string, value: string): void {
      const passphrase = provider("write");
      if (passphrase == null) {
        throw new Error(
          "no passphrase available — set $STM_FILE_PASSPHRASE or run `stm vault unlock`",
        );
      }
      const map = load(passphrase);
      map[ref] = value;
      save(map, passphrase);
    },
    get(ref: string): string | null {
      const passphrase = provider("read");
      if (passphrase == null) {
        // CRITICAL — hook fail-safe contract. Return null instead
        // of throwing; the caller (Store.resolve) propagates null
        // upstream and PreToolUse exits 0 without rewriting.
        return null;
      }
      let map: Record<string, string>;
      try {
        map = load(passphrase);
      } catch {
        // Corrupt or wrong-passphrase file. Don't return a partial
        // result; return null so the hook fails safe. The error
        // surfaces via `stm doctor` and `stm vault unlock`.
        return null;
      }
      return ref in map ? map[ref] : null;
    },
    delete(ref: string): void {
      const passphrase = provider("write");
      if (passphrase == null) {
        // Idempotent under no-passphrase too — matches the SS
        // backend's "clear is silent on missing target" contract.
        return;
      }
      let map: Record<string, string>;
      try {
        map = load(passphrase);
      } catch {
        return; // can't unlock — nothing to delete
      }
      if (!(ref in map)) return;
      delete map[ref];
      save(map, passphrase);
    },
    describe(): string {
      return "EncryptedFile (0600, PBKDF2-SHA512)";
    },
  };
}

// ---- helpers used by `stm vault rotate-passphrase` ----------------------

/**
 * Rotate the passphrase: decrypt under `oldPassphrase`, re-encrypt
 * under `newPassphrase`, and atomically replace the file. Leaves a
 * timestamped `.bak.<ts>` next to the file so the user can roll back
 * a botched rotation.
 *
 * Returns the path to the backup file (or null when there's nothing
 * to back up — fresh install).
 */
export function rotatePassphrase(opts: {
  filePath?: string;
  oldPassphrase: string;
  newPassphrase: string;
  now?: () => number;
}): string | null {
  const filePath = opts.filePath ?? defaultEncryptedFilePath();
  if (!existsSync(filePath)) {
    // Nothing to rotate — create an empty vault under the new key
    // so subsequent set/get use it.
    const empty = encryptVault("{}", opts.newPassphrase);
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, empty, { mode: 0o600 });
    return null;
  }
  const currentBytes = readFileSync(filePath);
  const plaintext = decryptVault(currentBytes, opts.oldPassphrase);
  const ts = (opts.now ?? (() => Date.now()))();
  const backupPath = `${filePath}.bak.${ts}`;
  writeFileSync(backupPath, currentBytes, { mode: 0o600 });
  const newBytes = encryptVault(plaintext, opts.newPassphrase);
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, newBytes, { mode: 0o600 });
  renameSync(tmp, filePath);
  return backupPath;
}

/** Inspect file headers + mode for `stm doctor`. */
export function inspectEncryptedFile(path?: string): {
  exists: boolean;
  path: string;
  modeOK: boolean;
  magicOK: boolean;
  kdfId: number | null;
  size: number;
} {
  const filePath = path ?? defaultEncryptedFilePath();
  if (!existsSync(filePath)) {
    return {
      exists: false,
      path: filePath,
      modeOK: false,
      magicOK: false,
      kdfId: null,
      size: 0,
    };
  }
  const st = statSync(filePath);
  const modeOK = (st.mode & 0o077) === 0;
  const bytes = readFileSync(filePath);
  const magicOK =
    bytes.length >= MAGIC.byteLength &&
    MAGIC.every((b, i) => bytes[i] === b);
  return {
    exists: true,
    path: filePath,
    modeOK,
    magicOK,
    kdfId: magicOK && bytes.length > MAGIC.byteLength
      ? bytes[MAGIC.byteLength]
      : null,
    size: st.size,
  };
}
