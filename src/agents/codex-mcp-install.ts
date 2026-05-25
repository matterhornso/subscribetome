// Codex MCP-block installer (v0.7.0).
//
// Adds (or refreshes / removes) the `[mcp_servers.subscribetome]`
// block in ~/.codex/config.toml so Codex spawns
// `stm codex mcp-server` automatically when a session starts. The
// hooks installer (v0.4.1) and this MCP installer are independent
// — they use DIFFERENT marker pairs so each can be toggled on its
// own. Users can run with hooks-only, mcp-only, both, or neither.
//
// All file-touching logic uses the generic splice helpers from
// `codex-hooks.ts`, so the on-disk shape is consistent and the
// idempotency story is shared.

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  defaultCodexConfigPath,
  rewriteOrAppendBlock,
  removeBlock,
  type InstallResult,
} from "./codex-hooks.ts";

/**
 * Marker pair for the MCP block. Distinct from the hooks pair so
 * `installHooks` and `installMcp` don't fight over each other's
 * content.
 */
export const STM_MCP_MARKER_PREFIX = "# stm: subscribetome managed-mcp";
export const STM_MCP_MARKER_CURRENT = "# stm: subscribetome managed-mcp v1";
export const STM_MCP_END_MARKER = "# stm: end subscribetome managed-mcp";

/** Path to the `stm` CLI entrypoint that hosts the MCP server. */
export function stmCliPath(rootOverride?: string): string {
  // src/agents/codex-mcp-install.ts → repo root is two levels up.
  const root = rootOverride ?? resolve(import.meta.dir, "..", "..");
  return resolve(root, "src", "cli.ts");
}

/**
 * The TOML block we manage. Uses Codex's `[mcp_servers.<name>]`
 * schema — the local-stdio transport variant (Codex spawns the
 * `command` with the given args; stdio is JSON-RPC).
 *
 * Why an absolute `bun` path instead of trusting PATH:
 *   Codex spawns hooks/MCP servers in its own environment, which
 *   may differ from the user's interactive shell PATH. `bun` is
 *   resolved at install time via `which`. If a user installs bun
 *   AFTER installing stm, `stm codex install-mcp` will refresh the
 *   path on the next run.
 */
export function renderMcpBlock(opts: {
  bunPath: string;
  cliPath: string;
}): string {
  const bun = opts.bunPath.replace(/"/g, '\\"');
  const cli = opts.cliPath.replace(/"/g, '\\"');
  return [
    STM_MCP_MARKER_CURRENT,
    "# Managed by `stm codex install-mcp`. Do not edit between the markers —",
    "# changes are overwritten on reinstall. Run `stm codex install-mcp --remove`",
    "# to clean these out.",
    "",
    "[mcp_servers.subscribetome]",
    `command = "${bun}"`,
    `args = ["${cli}", "codex", "mcp-server"]`,
    "",
    STM_MCP_END_MARKER,
  ].join("\n");
}

/** Resolve the absolute path to `bun` on the host. */
export function resolveBunPath(spawnSync?: typeof import("node:child_process").spawnSync): string {
  const sp = spawnSync ?? require("node:child_process").spawnSync;
  // Try `command -v bun` first — the POSIX-portable lookup. Fall
  // back to a known default location if PATH lookup fails (the
  // resolver in `paths.ts` uses the same fallback pattern).
  try {
    const r = sp("command", ["-v", "bun"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) {
      const path = String(r.stdout).trim().split("\n")[0];
      if (path && path.startsWith("/")) return path;
    }
  } catch {
    /* fall through */
  }
  try {
    const r = sp("which", ["bun"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) {
      const path = String(r.stdout).trim().split("\n")[0];
      if (path && path.startsWith("/")) return path;
    }
  } catch {
    /* fall through */
  }
  // Last resort: known install location.
  return process.env.HOME ? `${process.env.HOME}/.bun/bin/bun` : "/usr/local/bin/bun";
}

export interface InstallMcpOptions {
  configPath?: string;
  rootOverride?: string;
  dryRun?: boolean;
  /** Override the resolved bun path — tests pin a value. */
  bunPath?: string;
  /** Use this clock for the backup suffix — tests pin it. */
  now?: () => number;
}

export function installMcp(opts: InstallMcpOptions = {}): InstallResult {
  const configPath = opts.configPath ?? defaultCodexConfigPath();
  const block = renderMcpBlock({
    bunPath: opts.bunPath ?? resolveBunPath(),
    cliPath: stmCliPath(opts.rootOverride),
  });

  let current = "";
  if (existsSync(configPath)) current = readFileSync(configPath, "utf8");

  const updated = rewriteOrAppendBlock(
    current,
    block,
    STM_MCP_MARKER_PREFIX,
    STM_MCP_END_MARKER,
  );
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

  return { changed, alreadyInstalled, configPath, contents: updated, backupPath };
}

export function uninstallMcp(opts: { configPath?: string; dryRun?: boolean; now?: () => number } = {}): InstallResult {
  const configPath = opts.configPath ?? defaultCodexConfigPath();
  if (!existsSync(configPath)) {
    return { changed: false, alreadyInstalled: false, configPath, contents: "", backupPath: null };
  }
  const current = readFileSync(configPath, "utf8");
  const updated = removeBlock(current, STM_MCP_MARKER_PREFIX, STM_MCP_END_MARKER);
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
    alreadyInstalled: current.includes(STM_MCP_MARKER_PREFIX),
    configPath,
    contents: updated,
    backupPath,
  };
}

export interface McpDoctorVerdict {
  configPath: string;
  configPresent: boolean;
  blockPresent: boolean;
  blockUpToDate: boolean;
  ok: boolean;
  summary: string[];
}

export function doctorMcp(opts: { configPath?: string; rootOverride?: string; bunPath?: string } = {}): McpDoctorVerdict {
  const configPath = opts.configPath ?? defaultCodexConfigPath();
  const expected = renderMcpBlock({
    bunPath: opts.bunPath ?? resolveBunPath(),
    cliPath: stmCliPath(opts.rootOverride),
  });
  const configPresent = existsSync(configPath);
  const current = configPresent ? readFileSync(configPath, "utf8") : "";
  const blockPresent =
    current.includes(STM_MCP_MARKER_CURRENT) || current.includes(STM_MCP_MARKER_PREFIX);
  const blockUpToDate = current.includes(expected);

  const summary: string[] = [];
  if (!configPresent) {
    summary.push(
      `~/.codex/config.toml is missing — Codex hasn't been configured on this host. ` +
        `Run \`stm codex install-mcp\` to create it with the MCP server block.`,
    );
  } else if (!blockPresent) {
    summary.push(
      `Codex config exists but the stm MCP block is missing. Run ` +
        `\`stm codex install-mcp\` to register the higher-assurance ` +
        `Option-2 wrapper.`,
    );
  } else if (!blockUpToDate) {
    summary.push(
      `Codex config has an stm MCP block but it is out of date (the ` +
        `bun path or stm CLI path has changed). Run \`stm codex ` +
        `install-mcp\` to refresh it.`,
    );
  }
  if (blockPresent) {
    summary.push(
      `NOTE: Option 2 (MCP-wrapped) is the higher-assurance mode — the ` +
        `agent never sees the key, even as a session env var. Use this ` +
        `mode by prompting codex to call the \`stm_http_request\` MCP ` +
        `tool instead of \`curl\` directly.`,
    );
  }

  const ok = configPresent && blockPresent && blockUpToDate;
  return { configPath, configPresent, blockPresent, blockUpToDate, ok, summary };
}
