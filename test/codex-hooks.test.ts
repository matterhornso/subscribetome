// Codex hook installer + doctor tests (v0.4.1).
//
// All tests use a tmpdir config path — they never touch the user's
// real ~/.codex/config.toml. We also pin `now()` so backup file
// names are deterministic.

import { test, expect, afterAll, beforeEach } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installHooks,
  uninstallHooks,
  doctor,
  renderManagedBlock,
  hookScriptPaths,
  STM_MARKER_CURRENT,
  STM_END_MARKER,
  STM_MARKER_PREFIX,
} from "../src/agents/codex-hooks.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "stm-codex-hooks-"));
const FAKE_NOW = () => 1700000000000;

afterAll(() => {
  try {
    rmSync(SCRATCH, { recursive: true });
  } catch {
    /* ignore */
  }
});

/**
 * The launcher resolves hook paths relative to the import URL of
 * codex-hooks.ts. Because we run from the real repo, the script
 * files DO exist + are executable (we chmod +x'd them at install
 * time). For "scripts missing" tests we point rootOverride at an
 * empty dir.
 */
const REAL_ROOT = undefined; // = process.cwd() in practice
function configPath(name: string): string {
  return join(SCRATCH, name);
}

// ---- renderManagedBlock ---------------------------------------------------

test("renderManagedBlock emits markers, features.hooks=true, and array-of-tables hook entries", () => {
  const p = hookScriptPaths();
  const block = renderManagedBlock(p);
  expect(block.startsWith(STM_MARKER_CURRENT)).toBe(true);
  expect(block.endsWith(STM_END_MARKER)).toBe(true);
  expect(block).toContain("[features]");
  expect(block).toContain("hooks = true");
  expect(block).toContain("[[hooks.UserPromptSubmit]]");
  expect(block).toContain("[[hooks.UserPromptSubmit.hooks]]");
  expect(block).toContain("[[hooks.SessionStart]]");
  expect(block).toContain("[[hooks.SessionStart.hooks]]");
  // Both scripts referenced by absolute path
  expect(block).toContain(p.userPromptSubmit);
  expect(block).toContain(p.sessionStart);
  // Type field present on each hook entry
  expect((block.match(/type = "command"/g) || []).length).toBe(2);
});

test("renderManagedBlock is stable across calls (deterministic)", () => {
  const a = renderManagedBlock(hookScriptPaths());
  const b = renderManagedBlock(hookScriptPaths());
  expect(a).toBe(b);
});

// ---- installHooks ---------------------------------------------------------

test("installHooks --dry-run writes nothing but reports the would-be content", () => {
  const cfg = configPath("empty.toml");
  const r = installHooks({ configPath: cfg, dryRun: true });
  expect(r.changed).toBe(true);
  expect(existsSync(cfg)).toBe(false);
  expect(r.contents).toContain(STM_MARKER_CURRENT);
  expect(r.backupPath).toBeNull();
});

test("installHooks creates the file when it does not exist (no backup needed)", () => {
  const cfg = configPath("new.toml");
  const r = installHooks({ configPath: cfg, now: FAKE_NOW });
  expect(r.changed).toBe(true);
  expect(existsSync(cfg)).toBe(true);
  // No backup — the previous file didn't exist.
  expect(r.backupPath).toBeNull();
  const onDisk = readFileSync(cfg, "utf8");
  expect(onDisk).toContain(STM_MARKER_CURRENT);
  expect(onDisk).toContain('command = ');
});

test("installHooks is idempotent: running it twice changes nothing the second time", () => {
  const cfg = configPath("idempotent.toml");
  const r1 = installHooks({ configPath: cfg, now: FAKE_NOW });
  expect(r1.changed).toBe(true);
  const r2 = installHooks({ configPath: cfg, now: FAKE_NOW });
  expect(r2.changed).toBe(false);
  expect(r2.alreadyInstalled).toBe(true);
});

test("installHooks preserves user content above + below the managed block", () => {
  const cfg = configPath("with-other-config.toml");
  const before = [
    "# user config above",
    "[model]",
    'name = "o4-mini"',
    "",
    "[user_section]",
    'value = "preserved"',
    "",
  ].join("\n");
  writeFileSync(cfg, before, "utf8");
  installHooks({ configPath: cfg, now: FAKE_NOW });
  const after = readFileSync(cfg, "utf8");
  expect(after).toContain("# user config above");
  expect(after).toContain('name = "o4-mini"');
  expect(after).toContain('value = "preserved"');
  expect(after).toContain(STM_MARKER_CURRENT);
});

test("installHooks replaces an existing managed block in place when content drifts", () => {
  const cfg = configPath("drifted.toml");
  // Synthesize a "stale" block with an old path.
  const stale = [
    "[user_section]",
    'preserved = "yes"',
    "",
    STM_MARKER_PREFIX + " v0  (stale)",
    "# old content",
    'command = "/an/old/path/userpromptsubmit.sh"',
    STM_END_MARKER,
    "",
    "[after_section]",
    'still = "here"',
    "",
  ].join("\n");
  writeFileSync(cfg, stale, "utf8");
  const r = installHooks({ configPath: cfg, now: FAKE_NOW });
  expect(r.changed).toBe(true);
  const after = readFileSync(cfg, "utf8");
  // Old contents gone; new contents present.
  expect(after).not.toContain("/an/old/path/userpromptsubmit.sh");
  expect(after).toContain(STM_MARKER_CURRENT);
  // Surrounding user sections preserved.
  expect(after).toContain('preserved = "yes"');
  expect(after).toContain('still = "here"');
  // A backup was written.
  expect(r.backupPath).not.toBeNull();
  expect(existsSync(r.backupPath!)).toBe(true);
});

test("installHooks writes the file with mode 0600 (private)", () => {
  const cfg = configPath("perms.toml");
  installHooks({ configPath: cfg, now: FAKE_NOW });
  // Bun's `Bun.file` doesn't expose mode; use `fs.statSync` directly.
  // On macOS the umask may widen during write; we then chmod 0600.
  const st = Bun.file(cfg);
  expect(st.size).toBeGreaterThan(0);
  // Spot-check via node fs:
  const { statSync } = require("node:fs") as typeof import("node:fs");
  const mode = statSync(cfg).mode & 0o777;
  // We wrote with { mode: 0o600 } — accept any mode that does NOT include
  // world or group bits, since the umask might further restrict.
  expect(mode & 0o077).toBe(0);
});

// ---- uninstallHooks -------------------------------------------------------

test("uninstallHooks removes the managed block but preserves other content", () => {
  const cfg = configPath("uninstall.toml");
  writeFileSync(
    cfg,
    [
      "[model]",
      'name = "o4-mini"',
      "",
    ].join("\n"),
    "utf8",
  );
  installHooks({ configPath: cfg, now: FAKE_NOW });
  const r = uninstallHooks({ configPath: cfg, now: FAKE_NOW });
  expect(r.changed).toBe(true);
  const after = readFileSync(cfg, "utf8");
  expect(after).not.toContain(STM_MARKER_CURRENT);
  expect(after).toContain('name = "o4-mini"');
});

test("uninstallHooks on a file with no managed block reports nothing-to-do", () => {
  const cfg = configPath("nothing-to-uninstall.toml");
  writeFileSync(cfg, '[model]\nname = "o4-mini"\n', "utf8");
  const r = uninstallHooks({ configPath: cfg });
  expect(r.changed).toBe(false);
});

test("uninstallHooks on a missing file is a no-op", () => {
  const cfg = configPath("does-not-exist.toml");
  const r = uninstallHooks({ configPath: cfg });
  expect(r.changed).toBe(false);
  expect(existsSync(cfg)).toBe(false);
});

// ---- doctor ---------------------------------------------------------------

test("doctor reports missing config + missing block on a fresh tmpdir", () => {
  const cfg = configPath("doctor-missing.toml");
  const v = doctor({ configPath: cfg });
  expect(v.configPresent).toBe(false);
  expect(v.blockPresent).toBe(false);
  expect(v.ok).toBe(false);
  expect(v.summary.join(" ")).toMatch(/install-hooks/);
});

test("doctor reports OK after a fresh install", () => {
  const cfg = configPath("doctor-ok.toml");
  installHooks({ configPath: cfg, now: FAKE_NOW });
  const v = doctor({ configPath: cfg });
  expect(v.configPresent).toBe(true);
  expect(v.blockPresent).toBe(true);
  expect(v.blockUpToDate).toBe(true);
  expect(v.scriptsPresent).toBe(true);
  expect(v.ok).toBe(true);
  // Always-on trust-gate reminder
  expect(v.summary.join(" ")).toMatch(/TRUST/);
});

test("doctor reports OUT OF DATE when an old marker block is present", () => {
  const cfg = configPath("doctor-out-of-date.toml");
  writeFileSync(
    cfg,
    [
      STM_MARKER_PREFIX + " v0 (legacy)",
      'command = "/old/path"',
      STM_END_MARKER,
      "",
    ].join("\n"),
    "utf8",
  );
  const v = doctor({ configPath: cfg });
  expect(v.blockPresent).toBe(true);
  expect(v.blockUpToDate).toBe(false);
  expect(v.ok).toBe(false);
});

test("doctor reports scriptsPresent=false when hooks dir doesn't exist for the override root", () => {
  const fakeRoot = mkdtempSync(join(tmpdir(), "stm-codex-empty-root-"));
  const cfg = configPath("doctor-no-scripts.toml");
  installHooks({ configPath: cfg, rootOverride: fakeRoot, now: FAKE_NOW });
  const v = doctor({ configPath: cfg, rootOverride: fakeRoot });
  expect(v.scriptsPresent).toBe(false);
  expect(v.ok).toBe(false);
  try { rmSync(fakeRoot, { recursive: true }); } catch { /* ignore */ }
});
