// Filesystem locations for subscribetome's runtime state.
//
// State lives in ~/.subscribetome/ (NOT in the plugin directory, which is
// reinstalled/updated). The SQLite inventory and the daemon descriptor live
// here. Real key values never live on disk here — they go to the OS keychain.
import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";

export const DATA_DIR = join(homedir(), ".subscribetome");
/** SQLite inventory path. Override with $STM_DB (used by the test suite). */
export const DB_PATH = process.env.STM_DB || join(DATA_DIR, "db.sqlite");
/** Daemon descriptor: { port, token, pid } — written 0600 while the daemon runs. */
export const DAEMON_FILE = join(DATA_DIR, "daemon.json");

/**
 * Keychain service name. Override with $STM_KEYCHAIN_SERVICE (used by tests).
 * Resolved on each call rather than frozen at module load, so a process can
 * set the env var after importing this module — the test suite relies on this
 * to point an in-process Store and its spawned hook subprocesses at one shared
 * keychain service.
 */
export function keychainService(): string {
  return process.env.STM_KEYCHAIN_SERVICE || "subscribetome";
}

/**
 * Create the data directory (0700) if absent; returns its path. The `dir`
 * argument defaults to DATA_DIR and exists so the behaviour is unit-testable
 * against a temp path without touching the real ~/.subscribetome.
 */
export function ensureDataDir(dir: string = DATA_DIR): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's `mode` applies only when it CREATES the dir — a pre-existing
  // dir from an older build (or a loose umask) keeps its old perms. Re-tighten
  // to 0700 unconditionally: the SQLite DB's WAL/SHM sidecars are created
  // inside here and inherit only the dir's containment, so a loose dir would
  // expose audit-log command text + card last-4 to other local users.
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort — non-POSIX filesystems / Windows */
  }
  return dir;
}
