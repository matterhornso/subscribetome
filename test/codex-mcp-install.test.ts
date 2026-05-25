// Codex MCP installer tests (v0.7.0).
//
// The MCP block uses a SEPARATE marker pair from the hooks block
// (v0.4.1) so install-hooks and install-mcp are independent. We
// verify here that running both installers leaves both blocks
// intact — they must not stomp on each other.

import { test, expect, afterAll } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installMcp,
  uninstallMcp,
  doctorMcp,
  renderMcpBlock,
  STM_MCP_MARKER_CURRENT,
  STM_MCP_MARKER_PREFIX,
  STM_MCP_END_MARKER,
  resolveBunPath,
  stmCliPath,
} from "../src/agents/codex-mcp-install.ts";
import { installHooks, STM_MARKER_CURRENT } from "../src/agents/codex-hooks.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "stm-codex-mcp-"));
const FIXED_BUN = "/Users/abhinavramesh/.bun/bin/bun";
const FIXED_NOW = () => 1700000000000;

afterAll(() => {
  try {
    rmSync(SCRATCH, { recursive: true });
  } catch {
    /* ignore */
  }
});

function cfg(name: string): string {
  return join(SCRATCH, name);
}

// ---- renderMcpBlock -----------------------------------------------------

test("renderMcpBlock emits markers + [mcp_servers.subscribetome] + bun command", () => {
  const block = renderMcpBlock({
    bunPath: FIXED_BUN,
    cliPath: "/some/path/to/cli.ts",
  });
  expect(block.startsWith(STM_MCP_MARKER_CURRENT)).toBe(true);
  expect(block.endsWith(STM_MCP_END_MARKER)).toBe(true);
  expect(block).toContain("[mcp_servers.subscribetome]");
  expect(block).toContain(`command = "${FIXED_BUN}"`);
  expect(block).toContain('args = ["/some/path/to/cli.ts", "codex", "mcp-server"]');
});

// ---- installMcp ---------------------------------------------------------

test("installMcp --dry-run writes nothing but reports the would-be content", () => {
  const path = cfg("dry.toml");
  const r = installMcp({ configPath: path, dryRun: true, bunPath: FIXED_BUN });
  expect(r.changed).toBe(true);
  expect(existsSync(path)).toBe(false);
  expect(r.contents).toContain(STM_MCP_MARKER_CURRENT);
});

test("installMcp creates the file when none exists (no backup needed)", () => {
  const path = cfg("new.toml");
  const r = installMcp({ configPath: path, bunPath: FIXED_BUN, now: FIXED_NOW });
  expect(r.changed).toBe(true);
  expect(existsSync(path)).toBe(true);
  expect(r.backupPath).toBeNull();
  expect(readFileSync(path, "utf8")).toContain("[mcp_servers.subscribetome]");
});

test("installMcp is idempotent — running twice changes nothing the second time", () => {
  const path = cfg("idempotent.toml");
  installMcp({ configPath: path, bunPath: FIXED_BUN, now: FIXED_NOW });
  const r2 = installMcp({ configPath: path, bunPath: FIXED_BUN, now: FIXED_NOW });
  expect(r2.changed).toBe(false);
  expect(r2.alreadyInstalled).toBe(true);
});

test("installMcp preserves user content above + below the managed block", () => {
  const path = cfg("preserve.toml");
  const before = [
    "[model]",
    'name = "o4-mini"',
    "",
    "[user_section]",
    'preserved = "yes"',
    "",
  ].join("\n");
  writeFileSync(path, before, "utf8");
  installMcp({ configPath: path, bunPath: FIXED_BUN, now: FIXED_NOW });
  const after = readFileSync(path, "utf8");
  expect(after).toContain('name = "o4-mini"');
  expect(after).toContain('preserved = "yes"');
  expect(after).toContain("[mcp_servers.subscribetome]");
});

test("installMcp + installHooks coexist (different marker pairs)", () => {
  // The load-bearing claim: install-hooks (v0.4.1) and install-mcp
  // (v0.7.0) manage SEPARATE marker pairs and don't stomp each
  // other.
  const path = cfg("coexist.toml");
  installHooks({ configPath: path, now: FIXED_NOW });
  installMcp({ configPath: path, bunPath: FIXED_BUN, now: FIXED_NOW });
  const contents = readFileSync(path, "utf8");
  expect(contents).toContain(STM_MARKER_CURRENT); // hooks block still present
  expect(contents).toContain(STM_MCP_MARKER_CURRENT); // mcp block also present
  expect(contents).toContain("[[hooks.UserPromptSubmit]]");
  expect(contents).toContain("[mcp_servers.subscribetome]");
});

test("installMcp replaces an out-of-date block in place", () => {
  const path = cfg("stale.toml");
  const stale = [
    "[user_section]",
    'preserved = "yes"',
    "",
    STM_MCP_MARKER_PREFIX + " v0 (legacy)",
    '[mcp_servers.subscribetome]',
    'command = "/old/path/to/bun"',
    'args = ["/old/cli.ts"]',
    STM_MCP_END_MARKER,
    "",
    "[after_section]",
    'still = "here"',
    "",
  ].join("\n");
  writeFileSync(path, stale, "utf8");
  const r = installMcp({ configPath: path, bunPath: FIXED_BUN, now: FIXED_NOW });
  expect(r.changed).toBe(true);
  const after = readFileSync(path, "utf8");
  expect(after).not.toContain("/old/path/to/bun");
  expect(after).toContain(FIXED_BUN);
  // surrounding user config preserved
  expect(after).toContain('preserved = "yes"');
  expect(after).toContain('still = "here"');
  expect(r.backupPath).not.toBeNull();
});

// ---- uninstallMcp -------------------------------------------------------

test("uninstallMcp removes the MCP block but keeps other content (and the hooks block, if any)", () => {
  const path = cfg("uninstall.toml");
  installHooks({ configPath: path, now: FIXED_NOW });
  installMcp({ configPath: path, bunPath: FIXED_BUN, now: FIXED_NOW });
  const r = uninstallMcp({ configPath: path, now: FIXED_NOW });
  expect(r.changed).toBe(true);
  const after = readFileSync(path, "utf8");
  expect(after).not.toContain(STM_MCP_MARKER_CURRENT);
  expect(after).not.toContain("[mcp_servers.subscribetome]");
  // The hooks block survives — they're independent.
  expect(after).toContain(STM_MARKER_CURRENT);
});

test("uninstallMcp on a missing file is a no-op", () => {
  const r = uninstallMcp({ configPath: cfg("does-not-exist.toml") });
  expect(r.changed).toBe(false);
});

test("uninstallMcp on a file without an MCP block is a no-op", () => {
  const path = cfg("no-mcp.toml");
  writeFileSync(path, "[model]\nname=\"o4-mini\"\n", "utf8");
  const r = uninstallMcp({ configPath: path });
  expect(r.changed).toBe(false);
});

// ---- doctorMcp ---------------------------------------------------------

test("doctorMcp reports missing on a fresh tmpdir", () => {
  const v = doctorMcp({ configPath: cfg("doctor-missing.toml"), bunPath: FIXED_BUN });
  expect(v.configPresent).toBe(false);
  expect(v.blockPresent).toBe(false);
  expect(v.ok).toBe(false);
});

test("doctorMcp reports OK after a fresh install", () => {
  const path = cfg("doctor-ok.toml");
  installMcp({ configPath: path, bunPath: FIXED_BUN, now: FIXED_NOW });
  const v = doctorMcp({ configPath: path, bunPath: FIXED_BUN });
  expect(v.configPresent).toBe(true);
  expect(v.blockPresent).toBe(true);
  expect(v.blockUpToDate).toBe(true);
  expect(v.ok).toBe(true);
});

test("doctorMcp reports OUT OF DATE when the bun path drifts", () => {
  const path = cfg("doctor-drift.toml");
  installMcp({ configPath: path, bunPath: "/old/bun", now: FIXED_NOW });
  // Now check against a different bun path — simulates the user
  // moving bun or installing a new version.
  const v = doctorMcp({ configPath: path, bunPath: FIXED_BUN });
  expect(v.blockPresent).toBe(true);
  expect(v.blockUpToDate).toBe(false);
  expect(v.ok).toBe(false);
});

// ---- resolveBunPath / stmCliPath -----------------------------------------

test("resolveBunPath returns an absolute path under a working `command -v`", () => {
  const fake: any = (cmd: string, args: string[]) => {
    if (cmd === "command" && args[0] === "-v" && args[1] === "bun") {
      return { status: 0, stdout: "/usr/local/bin/bun\n", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "" };
  };
  expect(resolveBunPath(fake)).toBe("/usr/local/bin/bun");
});

test("resolveBunPath falls back to $HOME/.bun/bin/bun when no lookup succeeds", () => {
  const fake: any = () => ({ status: 1, stdout: "", stderr: "" });
  const path = resolveBunPath(fake);
  expect(path.endsWith("/.bun/bin/bun") || path === "/usr/local/bin/bun").toBe(true);
});

test("stmCliPath resolves to an absolute path ending in src/cli.ts", () => {
  const p = stmCliPath();
  expect(p.endsWith("/src/cli.ts")).toBe(true);
});
