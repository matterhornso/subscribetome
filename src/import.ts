// Import existing keys from .env files.
//
// v1 import scope: .env files only. Scanning the broader OS keychain for
// arbitrary third-party keys is deferred — `security dump-keychain` is
// intrusive (prompts per item) and noisy. subscribetome's own keychain
// entries are already in the inventory, so there is nothing to rediscover.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "./store.ts";
import { detectKeys } from "./detect.ts";
import { normalizeSegment } from "./grammar.ts";

export interface Candidate {
  id: string;
  file: string;
  varName: string;
  valueMasked: string;
  kind: string;
  suggestedTool: string;
  suggestedLabel: string;
}

const ENV_NAME = /(^|\/)\.env(\.[A-Za-z0-9_.-]+)?$/;
const KEYISH_NAME = /(KEY|TOKEN|SECRET|API|PASSWORD|PASSWD|AUTH|CREDENTIAL)/i;
const KEYISH_GLOBAL = /(KEY|TOKEN|SECRET|API|PASSWORD|PASSWD|AUTH|CREDENTIAL)/gi;

function mask(v: string): string {
  // Reveal at most two edge characters, and only when the value is long
  // enough that those characters are a small fraction of the secret.
  if (v.length < 16) return "*".repeat(Math.min(v.length, 12));
  return v.slice(0, 2) + "*".repeat(Math.min(20, v.length - 4)) + v.slice(-2);
}

function candidateId(file: string, varName: string): string {
  return createHash("sha256").update(`${file}\0${varName}`).digest("hex").slice(0, 16);
}

/** Suggest a tool name from an env var name: OPENAI_API_KEY -> openai. */
function suggestTool(varName: string): string {
  const stripped = varName.replace(KEYISH_GLOBAL, "").replace(/[_-]+/g, "-");
  return normalizeSegment(stripped) || "imported";
}

function listEnvFiles(dir: string, depth = 2): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git") continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (depth > 0) out.push(...listEnvFiles(full, depth - 1));
    } else if (ENV_NAME.test(full)) {
      out.push(full);
    }
  }
  return out;
}

function parseEnvLine(line: string): { name: string; value: string } | null {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) return null;
  let v = m[2].trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  return { name: m[1], value: v };
}

/** Scan .env files under the given directories for candidate keys. */
export function scanEnv(dirs: string[]): Candidate[] {
  const files = new Set<string>();
  for (const d of dirs) for (const f of listEnvFiles(d)) files.add(f);
  const candidates: Candidate[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const kv = parseEnvLine(line);
      if (!kv || !kv.value) continue;
      if (kv.value.includes("{{stm:")) continue; // already a placeholder
      if (kv.value.length < 12) continue;
      const hits = detectKeys(kv.value);
      const nameHint = KEYISH_NAME.test(kv.name);
      if (hits.length === 0 && !nameHint) continue;
      candidates.push({
        id: candidateId(file, kv.name),
        file,
        varName: kv.name,
        valueMasked: mask(kv.value),
        kind: hits[0]?.kind ?? "name-hint",
        suggestedTool: suggestTool(kv.name),
        suggestedLabel: "default",
      });
    }
  }
  return candidates;
}

/** Re-read a candidate's real value from its source file (server-side only).
 *  Internal: only importSelected needs it. */
function readCandidateValue(file: string, varName: string): string | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    const kv = parseEnvLine(line);
    if (kv && kv.name === varName) return kv.value;
  }
  return null;
}

/**
 * Phase 3 of session-and-project-scope.md: after a successful import,
 * either extend the matched project's scope with the freshly-imported
 * keys, or surface a suggestion to create a project from this cwd.
 *
 * - `kind: "added-to-existing"` — the cwd resolved (longest-prefix) to a
 *   registered project and we silently added each newly-imported
 *   `(tool, label)` to its scope. The user clearly imports keys *for*
 *   the project they're in; making them go re-check each one would be
 *   busywork.
 * - `kind: "suggest-create"` — no project matched. The dashboard can
 *   offer a one-click "Create project from this path" prefilled with
 *   `cwd`, `suggestedName`, and the imported (tool, label) list so the
 *   new project starts with a sensible scope.
 *
 * Returned by `importSelected` whenever a `cwd` is supplied. Absent
 * when the caller didn't pass a `cwd` (e.g. an automated import that
 * has no notion of "current project").
 */
export type ScopeUpdate =
  | {
      kind: "added-to-existing";
      projectId: number;
      projectName: string;
      projectPath: string;
      addedToScope: { tool: string; label: string }[];
    }
  | {
      kind: "suggest-create";
      cwd: string;
      suggestedName: string;
      imported: { tool: string; label: string }[];
    };

/** Derive a project name suggestion from the last segment of a path. */
function deriveProjectName(cwd: string): string {
  const stripped = cwd.replace(/\/+$/, "");
  const segs = stripped.split("/").filter(Boolean);
  return segs[segs.length - 1] || cwd;
}

/** Import selected candidates. The real value is read server-side here — it
 *  never travels to the browser.
 *
 *  When `cwd` is supplied (Phase 3), the result includes a `scopeUpdate`
 *  describing what to do with the freshly-imported keys at the project
 *  level — either we already extended an existing project's scope, or
 *  the UI should offer to create one. */
export function importSelected(
  selections: { file: string; varName: string; tool: string; label: string }[],
  opts?: {
    cwd?: string;
    /**
     * Override the SQLite DB path — used by the test suite, mirrors the
     * `STM_DB` env override documented in `paths.ts`. Production callers
     * leave this undefined and pick up `DB_PATH`.
     */
    dbPath?: string;
  },
): { imported: number; errors: string[]; scopeUpdate?: ScopeUpdate } {
  const store = opts?.dbPath ? new Store(opts.dbPath) : new Store();
  let imported = 0;
  const errors: string[] = [];
  const newlyImported: { tool: string; label: string }[] = [];
  try {
    for (const sel of selections) {
      const value = readCandidateValue(sel.file, sel.varName);
      if (!value) {
        errors.push(`${sel.varName}: value no longer found in ${sel.file}`);
        continue;
      }
      const tool = normalizeSegment(sel.tool);
      const label = normalizeSegment(sel.label || "default") || "default";
      try {
        store.addKey({
          tool,
          label,
          value,
          source: "imported",
        });
        imported++;
        newlyImported.push({ tool, label });
      } catch (e: any) {
        errors.push(`${sel.varName}: ${e?.message ?? e}`);
      }
    }

    // Phase 3: scope auto-suggest. Only kicks in when at least one key
    // landed AND the caller supplied a cwd. Failures here are
    // best-effort — the import itself already succeeded; a scope hiccup
    // shouldn't bubble.
    let scopeUpdate: ScopeUpdate | undefined;
    if (opts?.cwd && newlyImported.length > 0) {
      try {
        const project = store.matchProject(opts.cwd);
        if (project) {
          const added: { tool: string; label: string }[] = [];
          for (const { tool, label } of newlyImported) {
            if (!store.isInProjectScope(project.id, tool, label)) {
              try {
                store.addProjectScope(project.id, tool, label);
                added.push({ tool, label });
              } catch {
                /* skip — silent extension is best-effort */
              }
            }
          }
          if (added.length > 0) {
            scopeUpdate = {
              kind: "added-to-existing",
              projectId: project.id,
              projectName: project.name,
              projectPath: project.path,
              addedToScope: added,
            };
          }
        } else {
          scopeUpdate = {
            kind: "suggest-create",
            cwd: opts.cwd,
            suggestedName: deriveProjectName(opts.cwd),
            imported: newlyImported,
          };
        }
      } catch {
        /* scope lookup failed — leave scopeUpdate undefined */
      }
    }

    return { imported, errors, scopeUpdate };
  } finally {
    store.close();
  }
}

/** CLI: `stm import [dir...]` — scan and print candidates for review. */
export function runImport(args: string[]): void {
  const dirs = args.filter((a) => !a.startsWith("--"));
  const targets = dirs.length ? dirs : [process.cwd()];
  const candidates = scanEnv(targets);
  if (candidates.length === 0) {
    process.stdout.write(
      `No candidate keys found in .env files under: ${targets.join(", ")}\n`,
    );
    return;
  }
  process.stdout.write(`\nFound ${candidates.length} candidate key(s):\n\n`);
  for (const c of candidates) {
    process.stdout.write(
      `  ${c.varName}  (${c.kind})\n` +
        `    ${c.valueMasked}\n` +
        `    in ${c.file}\n` +
        `    -> suggest {{stm:${c.suggestedTool}:${c.suggestedLabel}}}\n\n`,
    );
  }
  process.stdout.write(
    `Review and import these in the dashboard:  stm dashboard  (Import section)\n` +
      `The dashboard lets you confirm and relabel each one before it is stored.\n`,
  );
}
