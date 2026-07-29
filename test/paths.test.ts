// ensureDataDir tests.
//
// The data dir holds the SQLite inventory and its WAL/SHM sidecars (audit-log
// command text, card last-4). It must be 0700. mkdirSync's `mode` only applies
// on creation, so a dir left loose by an older build must be re-tightened.

import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDataDir } from "../src/paths.ts";

const isPosix = process.platform !== "win32";
const t = isPosix ? test : test.skip;

t("creates a fresh data dir at 0700", () => {
  const base = mkdtempSync(join(tmpdir(), "stm-paths-"));
  const dir = join(base, "data");
  try {
    ensureDataDir(dir);
    expect(statSync(dir).mode & 0o077).toBe(0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

t("re-tightens a PRE-EXISTING loose dir to 0700", () => {
  const base = mkdtempSync(join(tmpdir(), "stm-paths-"));
  const dir = join(base, "data");
  try {
    // Simulate an older build / loose umask: dir already exists at 0755.
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    expect(statSync(dir).mode & 0o077).not.toBe(0); // precondition: loose

    ensureDataDir(dir);
    expect(statSync(dir).mode & 0o077).toBe(0); // now tightened
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
