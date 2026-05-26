// Encrypted full-vault snapshot — `stm vault export` / `stm vault import`.
//
// Why this exists: an early customer's worst day is realising they
// nuked `~/.subscribetome/` (or their OS keychain) and have no
// recovery path. v0.8.0 adds a single-file backup that captures
// EVERYTHING needed to bring a new machine to parity:
//
//   1. The full SQLite inventory (tools, keys metadata, policies,
//      projects, audit log) — captured as raw bytes so no schema
//      migration concerns matter on import.
//   2. Every active secret in the keystore, keyed by the same
//      keychain_ref UUID the inventory rows reference.
//
// The two are stitched together as JSON, then encrypted with the
// same PBKDF2-SHA512 + AES-256-GCM primitive the Tier 3 vault
// uses. The output is one file; the user moves it to wherever
// their backup discipline lives.
//
// Load-bearing invariants:
//   - Secrets are NEVER written unencrypted to disk. The plaintext
//     JSON lives only in memory during export/import. The encrypted
//     file is written via tmp + rename within the same directory
//     (atomic on POSIX), then chmod 0600.
//   - `decryptVault` collapses "wrong passphrase" and "tampered file"
//     into one error message — same surface as Tier 3's existing
//     contract.
//   - Import is destructive of the existing inventory. We back up
//     the current DB to `<db>.bak.<ts>` before writing the new one,
//     so the user has rollback.

import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import {
  encryptVault,
  decryptVault,
} from "./keystores/encrypted-file.ts";
import { selectKeyStore } from "./keystores/index.ts";
import { DB_PATH, ensureDataDir } from "./paths.ts";
import { STM_VERSION } from "./version.ts";

/** Bumped when the snapshot JSON shape changes. v1 is the format. */
export const SNAPSHOT_FORMAT_VERSION = "1";

/**
 * Plaintext snapshot shape. Lives only in memory between
 * encrypt and write (and between read and decrypt-and-restore).
 */
export interface VaultSnapshot {
  /** Format-version marker. Bumped on incompatible shape changes. */
  stmVaultSnapshot: string;
  /** ISO timestamp of when the export ran. */
  exportedAt: string;
  /** stm version that wrote this snapshot. Diagnostic only. */
  stmVersion: string;
  /** Source hostname. Diagnostic only. */
  hostname: string;
  /** Base64-encoded SQLite inventory database bytes. */
  db: string;
  /** keychain_ref → secret-value, only for active keys. */
  secrets: Record<string, string>;
}

/** Reads (tool, label, keychain_ref, status) tuples from a DB file. */
function readKeyRefs(
  dbPath: string,
): Array<{ tool: string; label: string; ref: string; status: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query(
        `SELECT t.name AS tool, k.label AS label,
                k.keychain_ref AS ref, k.status AS status
           FROM keys k JOIN tools t ON t.id = k.tool_id`,
      )
      .all() as Array<{
      tool: string;
      label: string;
      ref: string;
      status: string;
    }>;
    return rows;
  } finally {
    db.close();
  }
}

/**
 * Build an in-memory snapshot from the current inventory + keystore.
 *
 * Only ACTIVE keys are bundled. Revoked rows are still in the DB
 * but their values are typically gone from the keystore already
 * (or stale); skipping them keeps the snapshot honest.
 */
export function buildSnapshot(opts?: {
  dbPath?: string;
  resolveSecret?: (ref: string) => string | null;
}): VaultSnapshot {
  const dbPath = opts?.dbPath ?? DB_PATH;
  if (!existsSync(dbPath)) {
    throw new Error(
      `no inventory database at ${dbPath} — nothing to export. ` +
        `Add at least one key with \`stm add\` first.`,
    );
  }
  const dbBytes = readFileSync(dbPath);
  const refs = readKeyRefs(dbPath);
  const ks = selectKeyStore();
  const secrets: Record<string, string> = {};
  let skipped = 0;
  for (const r of refs) {
    if (r.status !== "active") continue;
    const val = opts?.resolveSecret
      ? opts.resolveSecret(r.ref)
      : ks.get(r.ref);
    if (val == null) {
      skipped++;
      continue;
    }
    secrets[r.ref] = val;
  }
  if (refs.length > 0 && Object.keys(secrets).length === 0 && skipped > 0) {
    // Every secret missing from the keystore — the user almost
    // certainly hit this from a corrupt or fresh keystore. Be
    // loud rather than silently writing an empty backup.
    throw new Error(
      `the inventory has ${refs.length} active key(s) but none of them ` +
        `resolved against the active keystore (${ks.describe()}). Refusing ` +
        `to write a snapshot that won't restore — fix the keystore first, ` +
        `then retry.`,
    );
  }
  return {
    stmVaultSnapshot: SNAPSHOT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    stmVersion: STM_VERSION,
    hostname: hostname(),
    db: dbBytes.toString("base64"),
    secrets,
  };
}

export interface ExportResult {
  path: string;
  keysExported: number;
  bytesWritten: number;
}

/**
 * Write an encrypted snapshot to `outPath`. Atomic (tmp + rename)
 * within the same directory; chmod 0600 on the final file.
 */
export function exportSnapshot(opts: {
  outPath: string;
  passphrase: string;
  dbPath?: string;
}): ExportResult {
  if (!opts.passphrase) {
    throw new Error("passphrase is empty — refusing to write a snapshot");
  }
  const snap = buildSnapshot({ dbPath: opts.dbPath });
  const json = JSON.stringify(snap);
  const enc = encryptVault(json, opts.passphrase);
  const tmp = `${opts.outPath}.tmp.${process.pid}`;
  writeFileSync(tmp, enc);
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows: no-op */
  }
  renameSync(tmp, opts.outPath);
  return {
    path: opts.outPath,
    keysExported: Object.keys(snap.secrets).length,
    bytesWritten: enc.length,
  };
}

export interface ImportResult {
  path: string;
  exportedAt: string;
  exportedFrom: string;
  stmVersion: string;
  keysRestored: number;
  keysSkipped: number;
  dbBackedUpTo: string | null;
}

/**
 * Decrypt + restore a snapshot.
 *
 * Destructive of the existing inventory: the SQLite at `dbPath` is
 * backed up to `<dbPath>.bak.<ts>` and replaced. Secrets are
 * written to the ACTIVE keystore under the same keychain_ref UUIDs
 * the snapshot recorded — so the freshly restored inventory rows
 * resolve correctly.
 */
export function importSnapshot(opts: {
  inPath: string;
  passphrase: string;
  dbPath?: string;
}): ImportResult {
  if (!existsSync(opts.inPath)) {
    throw new Error(`snapshot file not found: ${opts.inPath}`);
  }
  if (!opts.passphrase) {
    throw new Error("passphrase is empty — cannot decrypt snapshot");
  }
  const enc = readFileSync(opts.inPath);
  const json = decryptVault(enc, opts.passphrase);
  let snap: VaultSnapshot;
  try {
    snap = JSON.parse(json) as VaultSnapshot;
  } catch {
    throw new Error(
      `snapshot decrypted but is not valid JSON — file may be corrupt`,
    );
  }
  if (snap.stmVaultSnapshot !== SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      `snapshot format version ${snap.stmVaultSnapshot} not recognised ` +
        `(this stm understands "${SNAPSHOT_FORMAT_VERSION}"). Upgrade stm and retry.`,
    );
  }
  const dbPath = opts.dbPath ?? DB_PATH;
  ensureDataDir();
  let dbBackedUpTo: string | null = null;
  if (existsSync(dbPath)) {
    dbBackedUpTo = `${dbPath}.bak.${Date.now()}`;
    renameSync(dbPath, dbBackedUpTo);
  }
  const dbBytes = Buffer.from(snap.db, "base64");
  writeFileSync(dbPath, dbBytes);
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    /* Windows: no-op */
  }
  const ks = selectKeyStore();
  let restored = 0;
  let skipped = 0;
  for (const [ref, val] of Object.entries(snap.secrets)) {
    try {
      ks.set(ref, val);
      restored++;
    } catch {
      // Keystore wrote-failed for this entry — keep going so the
      // restore is best-effort. Caller surfaces the count delta.
      skipped++;
    }
  }
  return {
    path: opts.inPath,
    exportedAt: snap.exportedAt,
    exportedFrom: snap.hostname,
    stmVersion: snap.stmVersion,
    keysRestored: restored,
    keysSkipped: skipped,
    dbBackedUpTo,
  };
}

/**
 * Inspect a snapshot without decrypting payload — confirms it's
 * one of ours, reports size + mode, but doesn't ask for the
 * passphrase. Useful for `stm vault inspect-snapshot <file>`.
 */
export function inspectSnapshot(path: string): {
  path: string;
  exists: boolean;
  size: number;
  modeOK: boolean;
  magicOK: boolean;
} {
  if (!existsSync(path)) {
    return { path, exists: false, size: 0, modeOK: true, magicOK: false };
  }
  const st = statSync(path);
  const size = st.size;
  const modeOK = (st.mode & 0o077) === 0;
  const bytes = readFileSync(path);
  // Snapshot files use the same MAGIC as the Tier 3 vault since
  // they share the encryption primitive. inspectEncryptedFile()
  // is the symmetric reader.
  const expectedMagic = Buffer.from("stmenc01", "utf8");
  let magicOK = bytes.length >= expectedMagic.byteLength;
  for (let i = 0; magicOK && i < expectedMagic.byteLength; i++) {
    if (bytes[i] !== expectedMagic[i]) magicOK = false;
  }
  return { path, exists: true, size, modeOK, magicOK };
}

