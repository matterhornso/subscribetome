// Filesystem locations for subscribetome's runtime state.
//
// State lives in ~/.subscribetome/ (NOT in the plugin directory, which is
// reinstalled/updated). The SQLite inventory and the daemon descriptor live
// here. Real key values never live on disk here — they go to the OS keychain.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const DATA_DIR = join(homedir(), ".subscribetome");
/** SQLite inventory path. Override with $STM_DB (used by the test suite). */
export const DB_PATH = process.env.STM_DB || join(DATA_DIR, "db.sqlite");
/** Daemon descriptor: { port, token, pid } — written 0600 while the daemon runs. */
export const DAEMON_FILE = join(DATA_DIR, "daemon.json");

/** Keychain service name. Override with $STM_KEYCHAIN_SERVICE (used by tests). */
export const KEYCHAIN_SERVICE =
  process.env.STM_KEYCHAIN_SERVICE || "subscribetome";

/** Create the data directory (0700) if absent; returns its path. */
export function ensureDataDir(): string {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  return DATA_DIR;
}
