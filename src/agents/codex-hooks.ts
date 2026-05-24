// Codex hook installer + doctor (specs/cross-platform-and-codex.md §6).
//
// Per the Codex hooks docs (developers.openai.com/codex/hooks):
//   - User-level config lives at ~/.codex/config.toml.
//   - Hooks register as nested arrays of tables:
//       [[hooks.UserPromptSubmit]]
//       [[hooks.UserPromptSubmit.hooks]]
//       type = "command"
//       command = "/absolute/path/to/userpromptsubmit.sh"
//   - `features.hooks = true` enables the hook subsystem (set
//     defensively even when the build defaults it on).
//   - First launch after install: Codex prompts the user to TRUST the
//     hook (it records trust against the hook command's hash). Until
//     they approve, the hook is silently skipped. We surface this in
//     the install summary and the launch banner so it can't catch
//     anyone off guard.
//
// We DELIBERATELY do not use a TOML library — the project has zero
// runtime dependencies and a full TOML parser is overkill. The
// installer:
//   - Reads any existing config.toml (utf-8).
//   - Detects our marker block by an exact-string match on a `# stm:
//     subscribetome managed-hooks vN` header we own.
//   - Idempotent: if the marker is present AND the absolute paths it
//     contains match the resolved-at-runtime paths, the installer is
//     a no-op. If the paths drift (e.g. the user moved the checkout),
//     we rewrite the block in place.
//   - The user's other config keys are preserved verbatim — we only
//     touch our managed block.
//
// The `doctor()` function is the read-only inverse: parses the file
// shallowly and returns a verdict the CLI / launch banner can show.

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Marker header that delimits stm's managed block in the user's
 * config.toml. The "vN" lets us bump if we ever change the block
 * shape — older versions match the prefix and get rewritten.
 */
export const STM_MARKER_PREFIX = "# stm: subscribetome managed-hooks";
export const STM_MARKER_CURRENT = "# stm: subscribetome managed-hooks v1";
export const STM_END_MARKER = "# stm: end subscribetome managed-hooks";

/** Default user config path. Overridable in tests. */
export function defaultCodexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

/**
 * Absolute paths to the two hook scripts we ship. Computed from the
 * import URL of this module, which makes them stable across `bun`,
 * compiled binaries, and worktree relocations.
 */
export function hookScriptPaths(rootOverride?: string): {
  userPromptSubmit: string;
  sessionStart: string;
} {
  // src/agents/codex-hooks.ts → repo root is two levels up.
  const root = rootOverride ?? resolve(import.meta.dir, "..", "..");
  return {
    userPromptSubmit: join(root, "hooks", "codex", "userpromptsubmit.sh"),
    sessionStart: join(root, "hooks", "codex", "sessionstart.sh"),
  };
}

/**
 * The exact TOML block we manage. Written between
 * STM_MARKER_CURRENT and STM_END_MARKER so reinstall + rewrite is
 * one find-and-replace.
 *
 * `features.hooks = true` is set inside our block — if the user
 * already set it elsewhere we override-to-the-same-value, which is
 * harmless.
 */
export function renderManagedBlock(paths: ReturnType<typeof hookScriptPaths>): string {
  const u = paths.userPromptSubmit.replace(/"/g, '\\"');
  const s = paths.sessionStart.replace(/"/g, '\\"');
  return [
    STM_MARKER_CURRENT,
    "# Managed by `stm codex install-hooks`. Do not edit between the markers —",
    "# changes are overwritten on reinstall. Run `stm codex install-hooks --remove`",
    "# to clean these out.",
    "",
    "[features]",
    "hooks = true",
    "",
    "[[hooks.UserPromptSubmit]]",
    "[[hooks.UserPromptSubmit.hooks]]",
    'type = "command"',
    `command = "${u}"`,
    'timeout = 30',
    'statusMessage = "stm: scanning prompt for keys"',
    "",
    "[[hooks.SessionStart]]",
    "[[hooks.SessionStart.hooks]]",
    'type = "command"',
    `command = "${s}"`,
    'timeout = 30',
    'statusMessage = "stm: loading session guidance"',
    "",
    STM_END_MARKER,
  ].join("\n");
}

export interface InstallResult {
  /** True when we wrote (or would write) the file. */
  changed: boolean;
  /** True when our block was already present and the content matched. */
  alreadyInstalled: boolean;
  /** Path we wrote / would write. */
  configPath: string;
  /** New content of the file (after the write, or what would be written). */
  contents: string;
  /** Optional backup path the writer left behind. */
  backupPath: string | null;
}

/**
 * Install / update the managed block in config.toml.
 *
 * - `dryRun: true` — compute the new content but DO NOT touch disk;
 *   `changed` is the would-be answer.
 * - When a previous-version (or current-version) marker block is
 *   found, replace just that block in place — other entries above
 *   and below are preserved verbatim.
 * - Backup: when we write, copy the previous file to
 *   `<path>.stm.bak.<unix-ts>` so the user can roll back.
 */
export function installHooks(opts: {
  configPath?: string;
  rootOverride?: string;
  dryRun?: boolean;
  /** Use this clock for the backup suffix — tests pin it. */
  now?: () => number;
}): InstallResult {
  const configPath = opts.configPath ?? defaultCodexConfigPath();
  const paths = hookScriptPaths(opts.rootOverride);
  const block = renderManagedBlock(paths);

  let current = "";
  if (existsSync(configPath)) {
    current = readFileSync(configPath, "utf8");
  }

  const updated = rewriteOrAppendBlock(current, block);
  const alreadyInstalled = current.includes(block);
  const changed = updated !== current;

  let backupPath: string | null = null;
  if (changed && !opts.dryRun) {
    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(configPath)) {
      const ts = (opts.now ?? (() => Date.now()))();
      backupPath = `${configPath}.stm.bak.${ts}`;
      writeFileSync(backupPath, current, { mode: 0o600 });
    }
    writeFileSync(configPath, updated, { mode: 0o600 });
  }

  return {
    changed,
    alreadyInstalled,
    configPath,
    contents: updated,
    backupPath,
  };
}

/**
 * Splice the new block in. The strategy is conservative:
 *   1. If a `STM_MARKER_PREFIX` line + `STM_END_MARKER` pair is
 *      present, replace everything between them (inclusive).
 *   2. Otherwise, append the block to the file, ensuring exactly one
 *      blank line of separation.
 *
 * No TOML parsing: marker-based splice is the whole point.
 */
function rewriteOrAppendBlock(current: string, block: string): string {
  const lines = current.split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && lines[i].startsWith(STM_MARKER_PREFIX)) {
      start = i;
      continue;
    }
    if (start !== -1 && lines[i] === STM_END_MARKER) {
      end = i;
      break;
    }
  }
  if (start !== -1 && end !== -1) {
    const before = lines.slice(0, start);
    const after = lines.slice(end + 1);
    return [...before, block, ...after].join("\n").replace(/\n{3,}/g, "\n\n");
  }
  // No existing block — append.
  const trimmed = current.replace(/\s+$/, "");
  if (!trimmed) return block + "\n";
  return trimmed + "\n\n" + block + "\n";
}

export interface DoctorVerdict {
  configPath: string;
  /** True when the config file exists at all. */
  configPresent: boolean;
  /** True when our managed marker block is in the file. */
  blockPresent: boolean;
  /** True when the block in the file matches what we'd write today. */
  blockUpToDate: boolean;
  /** True when both hook scripts on disk exist and are executable. */
  scriptsPresent: boolean;
  /** True when the block + scripts are healthy. */
  ok: boolean;
  /** Human-readable summary lines. */
  summary: string[];
}

/**
 * Read-only health check. Used by the launch banner so we can show
 * "guardrails: installed" vs "guardrails: missing — run \`stm codex
 * install-hooks\`" honestly.
 */
export function doctor(opts: {
  configPath?: string;
  rootOverride?: string;
} = {}): DoctorVerdict {
  const configPath = opts.configPath ?? defaultCodexConfigPath();
  const paths = hookScriptPaths(opts.rootOverride);
  const expected = renderManagedBlock(paths);

  const configPresent = existsSync(configPath);
  const current = configPresent ? readFileSync(configPath, "utf8") : "";
  const blockPresent =
    current.includes(STM_MARKER_CURRENT) || current.includes(STM_MARKER_PREFIX);
  const blockUpToDate = current.includes(expected);

  // "scripts present + executable" — we tolerate non-x mode on the
  // theory that bun executes scripts via exec, but flag it because
  // it's a real source of "hooks silently don't fire" bugs.
  const scriptsPresent =
    isExecutableFile(paths.userPromptSubmit) &&
    isExecutableFile(paths.sessionStart);

  const summary: string[] = [];
  if (!configPresent) {
    summary.push(
      `~/.codex/config.toml is missing — Codex hasn't been configured on this host. ` +
        `Run \`stm codex install-hooks\` to create it with the guardrail block.`,
    );
  } else if (!blockPresent) {
    summary.push(
      `Codex config exists but the stm hook block is missing. Run ` +
        `\`stm codex install-hooks\` to add the UserPromptSubmit + SessionStart guards.`,
    );
  } else if (!blockUpToDate) {
    summary.push(
      `Codex config has an stm hook block but it is out of date (the ` +
        `script paths or the managed schema have changed). Run \`stm codex ` +
        `install-hooks\` to refresh it.`,
    );
  }
  if (!scriptsPresent) {
    summary.push(
      `One or both hook scripts under hooks/codex/ are missing or not ` +
        `executable. Reinstall stm or chmod +x hooks/codex/*.sh.`,
    );
  }
  if (blockPresent) {
    summary.push(
      `NOTE: Codex requires you to TRUST each hook on first launch ` +
        `(developers.openai.com/codex/hooks#trust). Until you approve, ` +
        `the hook is silently skipped. \`codex\` will prompt; press y.`,
    );
  }

  const ok = configPresent && blockPresent && blockUpToDate && scriptsPresent;
  return {
    configPath,
    configPresent,
    blockPresent,
    blockUpToDate,
    scriptsPresent,
    ok,
    summary,
  };
}

/** True when the file exists AND has at least one execute bit set. */
function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    // mode is unix-style; any of owner/group/other x bit counts.
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Remove the managed block. Symmetric with installHooks for users
 * who want to uninstall the guardrails without uninstalling stm.
 * Idempotent.
 */
export function uninstallHooks(opts: {
  configPath?: string;
  dryRun?: boolean;
  now?: () => number;
}): InstallResult {
  const configPath = opts.configPath ?? defaultCodexConfigPath();
  if (!existsSync(configPath)) {
    return {
      changed: false,
      alreadyInstalled: false,
      configPath,
      contents: "",
      backupPath: null,
    };
  }
  const current = readFileSync(configPath, "utf8");
  const updated = removeBlock(current);
  const changed = updated !== current;
  let backupPath: string | null = null;
  if (changed && !opts.dryRun) {
    const ts = (opts.now ?? (() => Date.now()))();
    backupPath = `${configPath}.stm.bak.${ts}`;
    writeFileSync(backupPath, current, { mode: 0o600 });
    writeFileSync(configPath, updated, { mode: 0o600 });
  }
  return {
    changed,
    alreadyInstalled: current.includes(STM_MARKER_PREFIX),
    configPath,
    contents: updated,
    backupPath,
  };
}

function removeBlock(current: string): string {
  const lines = current.split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && lines[i].startsWith(STM_MARKER_PREFIX)) {
      start = i;
      continue;
    }
    if (start !== -1 && lines[i] === STM_END_MARKER) {
      end = i;
      break;
    }
  }
  if (start === -1 || end === -1) return current;
  const before = lines.slice(0, start);
  const after = lines.slice(end + 1);
  return [...before, ...after].join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}
