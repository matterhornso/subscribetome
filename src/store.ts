// SQLite inventory of AI tools, API keys, and subscription metadata.
//
// Key VALUES never live in this database — only an opaque `keychain_ref`
// pointer. The real secret is in the OS keychain (keychain.ts). The DB is the
// inventory; the keychain is the vault.
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { DB_PATH, ensureDataDir } from "./paths.ts";
import { keychainSet, keychainGet, keychainDelete } from "./keychain.ts";
import { makePlaceholder, normalizeSegment } from "./grammar.ts";

export interface Tool {
  id: number;
  name: string;
  display_name: string;
  plan: string | null;
  monthly_cost: number | null;
  renews_on: string | null;
  created_at: string;
}

export interface KeyView {
  tool: string;
  tool_display: string;
  label: string;
  placeholder: string;
  source: string;
  status: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tools (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  plan          TEXT,
  monthly_cost  REAL,
  renews_on     TEXT,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id       INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  keychain_ref  TEXT UNIQUE NOT NULL,
  source        TEXT NOT NULL DEFAULT 'manual',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  UNIQUE (tool_id, label)
);
`;

const KEY_VIEW_SELECT = `
  SELECT t.name AS tool, t.display_name AS tool_display, k.label AS label,
         k.source AS source, k.status AS status, k.created_at AS created_at
    FROM keys k JOIN tools t ON t.id = k.tool_id`;

export class Store {
  readonly db: Database;

  constructor(path: string = DB_PATH) {
    ensureDataDir();
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- tools -------------------------------------------------------------

  /** Insert a tool, or update its metadata if it already exists. */
  upsertTool(input: {
    name: string;
    displayName?: string;
    plan?: string | null;
    monthlyCost?: number | null;
    renewsOn?: string | null;
  }): Tool {
    const name = normalizeSegment(input.name);
    if (!name) throw new Error("tool name is empty after normalization");
    const existing = this.getTool(name);
    if (existing) {
      this.db
        .query(
          `UPDATE tools SET display_name = ?,
             plan = COALESCE(?, plan),
             monthly_cost = COALESCE(?, monthly_cost),
             renews_on = COALESCE(?, renews_on)
           WHERE id = ?`,
        )
        .run(
          input.displayName ?? existing.display_name,
          input.plan ?? null,
          input.monthlyCost ?? null,
          input.renewsOn ?? null,
          existing.id,
        );
      return this.getTool(name)!;
    }
    this.db
      .query(
        `INSERT INTO tools (name, display_name, plan, monthly_cost, renews_on, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        input.displayName ?? name,
        input.plan ?? null,
        input.monthlyCost ?? null,
        input.renewsOn ?? null,
        new Date().toISOString(),
      );
    return this.getTool(name)!;
  }

  getTool(name: string): Tool | null {
    return (this.db
      .query(`SELECT * FROM tools WHERE name = ?`)
      .get(normalizeSegment(name)) as Tool | null) ?? null;
  }

  listTools(): Tool[] {
    return this.db.query(`SELECT * FROM tools ORDER BY name`).all() as Tool[];
  }

  /** Total declared monthly subscription spend across all tools. */
  monthlySpend(): number {
    const r = this.db
      .query(`SELECT COALESCE(SUM(monthly_cost), 0) AS total FROM tools`)
      .get() as { total: number };
    return r.total;
  }

  /**
   * Set a tool's subscription metadata directly. Unlike `upsertTool`, this
   * writes the values as given — passing `null` clears the field — so the
   * dashboard's edit form can both change and clear plan/cost/renewal.
   * Returns false if the tool does not exist.
   */
  setSubscription(input: {
    name: string;
    plan: string | null;
    monthlyCost: number | null;
    renewsOn: string | null;
  }): boolean {
    const name = normalizeSegment(input.name);
    const existing = this.getTool(name);
    if (!existing) return false;
    this.db
      .query(
        `UPDATE tools SET plan = ?, monthly_cost = ?, renews_on = ? WHERE id = ?`,
      )
      .run(input.plan, input.monthlyCost, input.renewsOn, existing.id);
    return true;
  }

  // ---- keys --------------------------------------------------------------

  /**
   * Store a new key. The secret goes to the keychain first; the inventory row
   * is inserted second and the keychain write is rolled back if the insert
   * fails (e.g. duplicate label).
   */
  addKey(input: {
    tool: string;
    label: string;
    value: string;
    source?: "manual" | "imported";
    displayName?: string;
  }): KeyView {
    const tool = normalizeSegment(input.tool);
    const label = normalizeSegment(input.label);
    if (!tool) throw new Error("tool name is empty after normalization");
    if (!label) throw new Error("label is empty after normalization");
    if (!input.value) throw new Error("key value is empty");

    const toolRow = this.upsertTool({ name: tool, displayName: input.displayName });
    const dupe = this.db
      .query(`SELECT id FROM keys WHERE tool_id = ? AND label = ?`)
      .get(toolRow.id, label);
    if (dupe) {
      throw new Error(`a key labelled "${label}" already exists for "${tool}"`);
    }

    const ref = randomUUID();
    keychainSet(ref, input.value);
    try {
      this.db
        .query(
          `INSERT INTO keys (tool_id, label, keychain_ref, source, status, created_at)
           VALUES (?, ?, ?, ?, 'active', ?)`,
        )
        .run(toolRow.id, label, ref, input.source ?? "manual", new Date().toISOString());
    } catch (e) {
      keychainDelete(ref);
      throw e;
    }
    return this.viewKey(tool, label)!;
  }

  /**
   * Resolve a placeholder address to its real secret.
   * Returns null for an unknown key or a revoked one.
   */
  resolve(tool: string, label: string): string | null {
    const row = this.db
      .query(
        `SELECT k.keychain_ref AS ref, k.status AS status
           FROM keys k JOIN tools t ON t.id = k.tool_id
          WHERE t.name = ? AND k.label = ?`,
      )
      .get(normalizeSegment(tool), normalizeSegment(label)) as
      | { ref: string; status: string }
      | null;
    if (!row || row.status !== "active") return null;
    return keychainGet(row.ref);
  }

  /** Mark a key revoked (v1: a metadata flag — no provider API call). */
  revokeKey(tool: string, label: string): boolean {
    const r = this.db
      .query(
        `UPDATE keys SET status = 'revoked'
          WHERE id = (
            SELECT k.id FROM keys k JOIN tools t ON t.id = k.tool_id
             WHERE t.name = ? AND k.label = ?
          )`,
      )
      .run(normalizeSegment(tool), normalizeSegment(label));
    return r.changes > 0;
  }

  viewKey(tool: string, label: string): KeyView | null {
    const r = this.db
      .query(`${KEY_VIEW_SELECT} WHERE t.name = ? AND k.label = ?`)
      .get(normalizeSegment(tool), normalizeSegment(label)) as
      | Omit<KeyView, "placeholder">
      | null;
    return r ? { ...r, placeholder: makePlaceholder(r.tool, r.label) } : null;
  }

  listKeys(): KeyView[] {
    const rows = this.db
      .query(`${KEY_VIEW_SELECT} ORDER BY t.name, k.label`)
      .all() as Omit<KeyView, "placeholder">[];
    return rows.map((r) => ({ ...r, placeholder: makePlaceholder(r.tool, r.label) }));
  }

  /** Placeholders of all active keys — for did-you-mean suggestions. */
  activePlaceholders(): string[] {
    return this.listKeys()
      .filter((k) => k.status === "active")
      .map((k) => k.placeholder);
  }
}
