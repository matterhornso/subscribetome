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

/** Import selected candidates. The real value is read server-side here — it
 *  never travels to the browser. */
export function importSelected(
  selections: { file: string; varName: string; tool: string; label: string }[],
): { imported: number; errors: string[] } {
  const store = new Store();
  let imported = 0;
  const errors: string[] = [];
  try {
    for (const sel of selections) {
      const value = readCandidateValue(sel.file, sel.varName);
      if (!value) {
        errors.push(`${sel.varName}: value no longer found in ${sel.file}`);
        continue;
      }
      try {
        store.addKey({
          tool: sel.tool,
          label: sel.label || "default",
          value,
          source: "imported",
        });
        imported++;
      } catch (e: any) {
        errors.push(`${sel.varName}: ${e?.message ?? e}`);
      }
    }
  } finally {
    store.close();
  }
  return { imported, errors };
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
