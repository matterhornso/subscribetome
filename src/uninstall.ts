// `stm uninstall` — clean removal of all stm data from this host.
//
// Trust signal for early customers: they need to know they can leave
// cleanly if stm doesn't work out. The Claude Code plugin uninstall
// removes the hook registrations automatically; THIS command removes
// everything stm wrote outside the plugin directory:
//
//   - Every active key from the OS keystore (whichever is active).
//   - The SQLite inventory at $STM_DB or ~/.subscribetome/db.sqlite.
//   - The encrypted-vault file (Tier 3, if present).
//   - The daemon descriptor at ~/.subscribetome/daemon.json; the daemon
//     itself is stopped via stopDaemon() first.
//   - The Codex hooks block from ~/.codex/config.toml (markers-delimited
//     so stm-managed lines are removed and the rest is preserved).
//   - The Codex MCP block from the same config.
//
// The Claude Code plugin's hook registration in
// ~/.claude/plugins/<name>/hooks.json is owned by Claude Code, not us;
// `/plugin uninstall stm` removes it. We don't touch the plugin
// directory.
//
// Safety:
//   - Interactive confirmation by default. `--yes` skips.
//   - We list what will be removed BEFORE doing anything (dry-run
//     by structure — `plan` first, then `execute`).
//   - Keystore deletes are best-effort; a failed delete is reported
//     but doesn't abort the uninstall (the user may have already
//     deleted some entries manually).

import { Database } from "bun:sqlite";
import {
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { DB_PATH, DAEMON_FILE, DATA_DIR } from "./paths.ts";
import { selectKeyStore } from "./keystores/index.ts";
import { defaultEncryptedFilePath } from "./keystores/encrypted-file.ts";
import { uninstallHooks as uninstallCodexHooks } from "./agents/codex-hooks.ts";
import { uninstallMcp as uninstallCodexMcp } from "./agents/codex-mcp-install.ts";

export interface UninstallPlan {
  keystoreName: string;
  keyRefs: string[];
  paths: Array<{ path: string; kind: "db" | "wal" | "shm" | "vault" | "daemon" | "data-dir" }>;
  codexConfigPath: string | null;
  codexHasHooksBlock: boolean;
  codexHasMcpBlock: boolean;
}

export interface UninstallResult {
  keysDeleted: number;
  keysFailed: Array<{ ref: string; error: string }>;
  pathsDeleted: string[];
  pathsFailed: Array<{ path: string; error: string }>;
  codexHooksRemoved: boolean;
  codexMcpRemoved: boolean;
}

/**
 * Inspect what an uninstall would do. Pure — touches the filesystem
 * only to stat existence. Used by the CLI to print the confirmation
 * banner BEFORE the user types y.
 */
export function planUninstall(opts?: { dbPath?: string }): UninstallPlan {
  const dbPath = opts?.dbPath ?? DB_PATH;
  const ks = selectKeyStore();

  // Collect keychain refs we'd need to delete. We don't actually
  // know what's in the keystore — we only know what the inventory
  // says we put there. Reading the DB directly avoids dragging in
  // the full Store/migration code.
  let refs: string[] = [];
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db
          .query(`SELECT keychain_ref AS ref FROM keys WHERE status = 'active'`)
          .all() as Array<{ ref: string }>;
        refs = rows.map((r) => r.ref);
      } finally {
        db.close();
      }
    } catch {
      // Schema mismatch, locked DB, etc. — keep going with an empty
      // list. The user will be told about the DB file removal anyway.
    }
  }

  const paths: UninstallPlan["paths"] = [];
  if (existsSync(dbPath)) paths.push({ path: dbPath, kind: "db" });
  for (const ext of ["-shm", "-wal"]) {
    if (existsSync(dbPath + ext)) {
      paths.push({ path: dbPath + ext, kind: ext === "-shm" ? "shm" : "wal" });
    }
  }
  if (existsSync(DAEMON_FILE)) paths.push({ path: DAEMON_FILE, kind: "daemon" });
  const vaultPath = defaultEncryptedFilePath();
  if (existsSync(vaultPath)) paths.push({ path: vaultPath, kind: "vault" });

  // Codex config: detect both blocks without modifying the file.
  let codexConfigPath: string | null = null;
  let codexHasHooks = false;
  let codexHasMcp = false;
  try {
    const { homedir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const candidate = join(homedir(), ".codex", "config.toml");
    if (existsSync(candidate)) {
      codexConfigPath = candidate;
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      const text = readFileSync(candidate, "utf8");
      codexHasHooks = /# stm: subscribetome managed-hooks/.test(text);
      codexHasMcp = /# stm: subscribetome managed-mcp/.test(text);
    }
  } catch {
    /* best-effort */
  }

  return {
    keystoreName: ks.describe(),
    keyRefs: refs,
    paths,
    codexConfigPath,
    codexHasHooksBlock: codexHasHooks,
    codexHasMcpBlock: codexHasMcp,
  };
}

/**
 * Execute the plan. Best-effort throughout — a failed step doesn't
 * abort the rest. The result records exactly what worked and what
 * didn't.
 */
export function executeUninstall(plan: UninstallPlan): UninstallResult {
  const ks = selectKeyStore();
  const result: UninstallResult = {
    keysDeleted: 0,
    keysFailed: [],
    pathsDeleted: [],
    pathsFailed: [],
    codexHooksRemoved: false,
    codexMcpRemoved: false,
  };

  for (const ref of plan.keyRefs) {
    try {
      ks.delete(ref);
      result.keysDeleted++;
    } catch (e: any) {
      result.keysFailed.push({ ref, error: e?.message ?? String(e) });
    }
  }

  for (const { path } of plan.paths) {
    try {
      rmSync(path, { force: true });
      result.pathsDeleted.push(path);
    } catch (e: any) {
      result.pathsFailed.push({ path, error: e?.message ?? String(e) });
    }
  }

  // Remove the data dir only if it's now empty. If a user happens to
  // keep notes there (the README mentions ~/.subscribetome implicitly
  // is "ours"), we'd rather leave it than nuke their files.
  try {
    if (existsSync(DATA_DIR)) {
      const { readdirSync, rmdirSync } = require("node:fs") as typeof import("node:fs");
      const entries = readdirSync(DATA_DIR);
      if (entries.length === 0) {
        rmdirSync(DATA_DIR);
        result.pathsDeleted.push(DATA_DIR);
      }
    }
  } catch {
    /* best-effort — leaving the dir is harmless */
  }

  if (plan.codexConfigPath) {
    if (plan.codexHasHooksBlock) {
      try {
        uninstallCodexHooks({ configPath: plan.codexConfigPath, dryRun: false });
        result.codexHooksRemoved = true;
      } catch {
        /* best-effort; the user can re-run install-hooks --remove */
      }
    }
    if (plan.codexHasMcpBlock) {
      try {
        uninstallCodexMcp({ configPath: plan.codexConfigPath, dryRun: false });
        result.codexMcpRemoved = true;
      } catch {
        /* best-effort */
      }
    }
  }

  return result;
}

/**
 * Render the plan as a human-readable confirmation banner.
 */
export function formatPlan(plan: UninstallPlan): string {
  const lines: string[] = [];
  lines.push("stm uninstall — this will remove the following from this host:");
  lines.push("");
  lines.push(`  Active keystore: ${plan.keystoreName}`);
  if (plan.keyRefs.length > 0) {
    lines.push(
      `  • ${plan.keyRefs.length} active key${plan.keyRefs.length === 1 ? "" : "s"} will be deleted from the keystore`,
    );
  } else {
    lines.push(`  • (no active keys recorded in inventory)`);
  }
  for (const { path, kind } of plan.paths) {
    const label =
      kind === "db" ? "inventory DB" :
      kind === "wal" ? "  SQLite WAL" :
      kind === "shm" ? "  SQLite shared-memory" :
      kind === "vault" ? "encrypted vault file" :
      kind === "daemon" ? "daemon descriptor" :
      kind;
    let size = "";
    try {
      size = ` (${statSync(path).size} bytes)`;
    } catch {
      /* ignore */
    }
    lines.push(`  • ${label}: ${path}${size}`);
  }
  if (plan.codexHasHooksBlock) {
    lines.push(`  • Codex hooks block in ${plan.codexConfigPath}`);
  }
  if (plan.codexHasMcpBlock) {
    lines.push(`  • Codex MCP block in ${plan.codexConfigPath}`);
  }
  lines.push("");
  lines.push("Not affected (you remove these separately):");
  lines.push("  • The plugin itself — run \`/plugin uninstall stm\` in Claude Code");
  lines.push("  • This stm install location (your bun/Claude-Code-plugin dir)");
  return lines.join("\n") + "\n";
}

export function formatResult(result: UninstallResult): string {
  const lines: string[] = [];
  lines.push(`removed ${result.keysDeleted} key${result.keysDeleted === 1 ? "" : "s"} from the keystore.`);
  if (result.keysFailed.length > 0) {
    lines.push(
      `  WARN: ${result.keysFailed.length} keystore delete${result.keysFailed.length === 1 ? "" : "s"} failed:`,
    );
    for (const f of result.keysFailed) {
      lines.push(`    ${f.ref}: ${f.error}`);
    }
  }
  for (const p of result.pathsDeleted) {
    lines.push(`removed ${p}`);
  }
  if (result.pathsFailed.length > 0) {
    lines.push(`  WARN: ${result.pathsFailed.length} file removal${result.pathsFailed.length === 1 ? "" : "s"} failed:`);
    for (const f of result.pathsFailed) {
      lines.push(`    ${f.path}: ${f.error}`);
    }
  }
  if (result.codexHooksRemoved) lines.push("removed Codex hooks block.");
  if (result.codexMcpRemoved) lines.push("removed Codex MCP block.");
  lines.push("");
  lines.push(
    "Done. To complete removal, run \`/plugin uninstall stm\` in Claude Code.",
  );
  return lines.join("\n") + "\n";
}
