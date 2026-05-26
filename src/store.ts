// SQLite inventory of AI tools, API keys, and subscription metadata.
//
// Key VALUES never live in this database — only an opaque `keychain_ref`
// pointer. The real secret is in the OS keychain (keychain.ts). The DB is the
// inventory; the keychain is the vault.
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DB_PATH, ensureDataDir } from "./paths.ts";
import { keychainSet, keychainGet, keychainDelete } from "./keychain.ts";
import { makePlaceholder, normalizeSegment } from "./grammar.ts";
import type { PolicyAction, PolicyRule } from "./policy.ts";

/**
 * Canonicalize a project path: expand a leading `~`, then resolve so it is
 * absolute, with no trailing slash. The trailing-slash rule matters because
 * `matchProject` does prefix matching on `path + "/"`.
 */
export function normalizeProjectPath(p: string): string {
  let s = p.trim();
  if (s === "~") s = homedir();
  else if (s.startsWith("~/")) s = homedir() + s.slice(1);
  s = resolve(s);
  // strip any trailing slash except on the root itself ("/")
  if (s.length > 1 && s.endsWith("/")) s = s.replace(/\/+$/, "");
  return s;
}

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
CREATE TABLE IF NOT EXISTS policies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ordering      INTEGER NOT NULL DEFAULT 100,
  when_key      TEXT,
  when_command  TEXT,
  when_agent    TEXT,
  when_project  TEXT,
  action        TEXT NOT NULL CHECK(action IN ('allow','deny','warn')),
  reason        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS policies_order_idx ON policies(ordering, id);
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT    NOT NULL,
  event      TEXT    NOT NULL CHECK(event IN (
                       'substitute','policy.deny','policy.warn',
                       'unresolved','malformed')),
  tool       TEXT,
  label      TEXT,
  command    TEXT,
  agent      TEXT,
  policy_id  INTEGER REFERENCES policies(id) ON DELETE SET NULL,
  reason     TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_ts_idx     ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_event_idx  ON audit_log(event, ts DESC);
CREATE TABLE IF NOT EXISTS projects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  path            TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  enforce_scope   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_path_idx ON projects(path);
CREATE TABLE IF NOT EXISTS project_scope (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tool_id     INTEGER NOT NULL REFERENCES tools(id)    ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  PRIMARY KEY (project_id, tool_id, label)
);
CREATE TABLE IF NOT EXISTS spend (
  tool_id     INTEGER PRIMARY KEY REFERENCES tools(id) ON DELETE CASCADE,
  fetched_usd REAL,
  fetched_at  TEXT,
  source      TEXT NOT NULL DEFAULT 'fetched'
                   CHECK(source IN ('fetched','manual','error')),
  last_error  TEXT
);
`;

/** Default cap on the audit_log rolling buffer. Overridable via STM_AUDIT_MAX. */
const AUDIT_DEFAULT_MAX = 10_000;
/** When we exceed the cap, prune this many rows in one pass. */
const AUDIT_PRUNE_BATCH = 1_000;

function auditMax(): number {
  const v = process.env.STM_AUDIT_MAX;
  if (!v) return AUDIT_DEFAULT_MAX;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : AUDIT_DEFAULT_MAX;
}

export type AuditEvent =
  | "substitute"
  | "policy.deny"
  | "policy.warn"
  | "unresolved"
  | "malformed";

export interface Project {
  id: number;
  path: string;
  name: string;
  /**
   * 0 = guidance-only (default); 1 = enforce. When 1, the PreToolUse hook
   * denies any substitution whose `(tool, label)` is not in this project's
   * `project_scope` rows. See command-policy.md Phase 3 and
   * session-and-project-scope.md §7.
   */
  enforce_scope: number;
  created_at: string;
}

export interface ProjectScopeEntry {
  /** Tool `name` from the `tools` table. */
  tool: string;
  /** The label segment. Together with `tool` it forms a `(tool, label)` address. */
  label: string;
  /** Placeholder rendered convenience: `{{stm:tool:label}}`. */
  placeholder: string;
}

/**
 * Spend tracking row — populated by `stm sync` when a provider's billing
 * API responds. Storage of an `error` source preserves the last-known-good
 * value (don't silently zero out, per specs/spend-visibility.md §5).
 */
export interface SpendRow {
  tool_id: number;
  /** Month-to-date USD as the provider reported it. May be 0; never negative. */
  fetched_usd: number | null;
  /** ISO timestamp the provider returned (or when we tried, on error). */
  fetched_at: string | null;
  /**
   * `fetched` = the value came from the provider (`last_error` is null).
   * `error`   = the most recent sync failed; `fetched_usd` is the last
   *             successful value (or null if no successful sync yet).
   * `manual`  = reserved for v1.x (CLI-typed override). Today the
   *             `tools.monthly_cost` ledger is the manual surface; this
   *             row only carries fetched data.
   */
  source: "fetched" | "manual" | "error";
  last_error: string | null;
}

export interface AuditRow {
  id: number;
  ts: string;
  event: AuditEvent;
  tool: string | null;
  label: string | null;
  /**
   * The Bash command, with `{{stm:...}}` placeholders STILL PRESENT — never
   * the substituted form. This is the load-bearing invariant of the audit
   * log; see specs/audit-log.md §5.
   */
  command: string | null;
  agent: string | null;
  policy_id: number | null;
  reason: string | null;
}

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
    this.migrate();
  }

  /**
   * Additive, idempotent migrations for DBs created by earlier versions.
   *
   * SQLite has no `ADD COLUMN IF NOT EXISTS`, so we introspect via
   * `PRAGMA table_info(...)` and only run the ALTER when the column is
   * missing. Each migration is safe to re-run on a fresh DB (the column
   * is already present via SCHEMA) and on an existing DB (the column gets
   * added with the documented default).
   *
   * Two columns land in v0.2.5 for command-policy.md Phase 3:
   *   - policies.when_project  (TEXT, nullable = "match anything")
   *   - projects.enforce_scope (INTEGER, default 0 = guidance-only)
   */
  private migrate(): void {
    const addColumnIfMissing = (
      table: string,
      column: string,
      ddl: string,
    ): void => {
      const cols = this.db
        .query(`PRAGMA table_info(${table})`)
        .all() as { name: string }[];
      if (cols.some((c) => c.name === column)) return;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };
    addColumnIfMissing("policies", "when_project", "when_project TEXT");
    addColumnIfMissing(
      "projects",
      "enforce_scope",
      "enforce_scope INTEGER NOT NULL DEFAULT 0",
    );
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

  /**
   * Total monthly spend across all tools. Each tool contributes its
   * fetched `spend.fetched_usd` when present, otherwise its manual
   * `tools.monthly_cost`. NULL on both sides counts as 0.
   *
   * v0.3.0 (specs/spend-visibility.md): existed before; semantics widened
   * to prefer fetched-when-available. Older callers see no regression —
   * with zero `spend` rows the result is identical to the previous SUM.
   */
  monthlySpend(): number {
    const r = this.db
      .query(
        `SELECT COALESCE(SUM(
            COALESCE(s.fetched_usd, t.monthly_cost, 0)
         ), 0) AS total
            FROM tools t
            LEFT JOIN spend s ON s.tool_id = t.id`,
      )
      .get() as { total: number };
    return r.total;
  }

  /**
   * Break the monthly spend down into "what came from a provider" vs
   * "what the user typed manually". Drives the dashboard header badge's
   * three states (fetched / partial / self-reported). See
   * specs/spend-visibility.md §4.
   */
  monthlySpendBreakdown(): {
    total: number;
    fetched: number;
    manual: number;
    /** Tools with a fetched_usd value (regardless of source flag). */
    fetchedTools: number;
    /** Tools without a fetched value, only their manual cost contributes. */
    manualTools: number;
  } {
    const r = this.db
      .query(
        `SELECT
           COALESCE(SUM(CASE WHEN s.fetched_usd IS NOT NULL
                             THEN s.fetched_usd ELSE 0 END), 0) AS fetched,
           COALESCE(SUM(CASE WHEN s.fetched_usd IS NULL
                             THEN COALESCE(t.monthly_cost, 0) ELSE 0 END), 0) AS manual,
           SUM(CASE WHEN s.fetched_usd IS NOT NULL THEN 1 ELSE 0 END) AS fetched_tools,
           SUM(CASE WHEN s.fetched_usd IS NULL
                          AND t.monthly_cost IS NOT NULL THEN 1 ELSE 0 END) AS manual_tools
           FROM tools t
           LEFT JOIN spend s ON s.tool_id = t.id`,
      )
      .get() as {
        fetched: number;
        manual: number;
        fetched_tools: number | null;
        manual_tools: number | null;
      };
    return {
      total: r.fetched + r.manual,
      fetched: r.fetched,
      manual: r.manual,
      fetchedTools: r.fetched_tools ?? 0,
      manualTools: r.manual_tools ?? 0,
    };
  }

  // ---- spend (specs/spend-visibility.md) ---------------------------------

  /**
   * Record a successful fetch from a provider. Upserts the spend row with
   * the new USD value, the timestamp the provider returned, and clears any
   * previous `last_error`.
   */
  setSpend(input: {
    toolId: number;
    usd: number;
    asOf: string;
  }): void {
    if (!Number.isFinite(input.usd) || input.usd < 0) {
      throw new Error("spend usd must be a non-negative finite number");
    }
    this.db
      .query(
        `INSERT INTO spend (tool_id, fetched_usd, fetched_at, source, last_error)
         VALUES (?, ?, ?, 'fetched', NULL)
         ON CONFLICT(tool_id) DO UPDATE SET
           fetched_usd = excluded.fetched_usd,
           fetched_at  = excluded.fetched_at,
           source      = 'fetched',
           last_error  = NULL`,
      )
      .run(input.toolId, input.usd, input.asOf);
  }

  /**
   * Record a sync failure for this tool. Preserves the previous
   * `fetched_usd` so the dashboard can show "stale, last good value
   * was $X · last attempt failed: <reason>" rather than silently zeroing.
   */
  markSpendError(toolId: number, error: string): void {
    // INSERT first time, UPDATE thereafter — without clobbering the
    // previously-good fetched_usd.
    this.db
      .query(
        `INSERT INTO spend (tool_id, fetched_usd, fetched_at, source, last_error)
         VALUES (?, NULL, ?, 'error', ?)
         ON CONFLICT(tool_id) DO UPDATE SET
           fetched_at  = excluded.fetched_at,
           source      = 'error',
           last_error  = excluded.last_error`,
      )
      .run(toolId, new Date().toISOString(), error);
  }

  getSpend(toolId: number): SpendRow | null {
    return (this.db
      .query(`SELECT * FROM spend WHERE tool_id = ?`)
      .get(toolId) as SpendRow | null) ?? null;
  }

  /**
   * All spend rows joined with their tool name for display. Most-recent
   * `fetched_at` first; rows that have never been fetched are excluded
   * (callers can fall back to `tools.monthly_cost`).
   */
  listSpend(): (SpendRow & { tool: string })[] {
    return this.db
      .query(
        `SELECT s.*, t.name AS tool
           FROM spend s JOIN tools t ON t.id = s.tool_id
          ORDER BY s.fetched_at DESC NULLS LAST`,
      )
      .all() as (SpendRow & { tool: string })[];
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

  /**
   * Rotate a key in place: write `newValue` to the keystore under a
   * fresh UUID, repoint the inventory row at it, then delete the old
   * keystore entry. The placeholder `{{stm:tool:label}}` is unchanged
   * — every existing hook flow keeps working, the value behind it is
   * just different.
   *
   * Failure modes:
   *   - (tool, label) doesn't exist → throws; nothing written.
   *   - Keystore set fails → throws; nothing written.
   *   - Inventory UPDATE fails → the new keystore entry is rolled back
   *     before re-throwing. Old key remains intact.
   *   - Old keystore delete fails → reported via the return value but
   *     the rotation is still considered successful (the inventory
   *     now points at the new ref; the old bytes are orphaned but
   *     unreferenced).
   *
   * Returns the freshly-generated keychain_ref so the caller (CLI)
   * can show it, and a boolean reporting whether the old keystore
   * entry was deleted cleanly.
   */
  rotateKey(input: {
    tool: string;
    label: string;
    newValue: string;
  }): { newRef: string; oldRefDeleted: boolean } {
    const tool = normalizeSegment(input.tool);
    const label = normalizeSegment(input.label);
    if (!input.newValue) throw new Error("new key value is empty");

    const row = this.db
      .query(
        `SELECT k.id AS id, k.keychain_ref AS oldRef
           FROM keys k JOIN tools t ON t.id = k.tool_id
          WHERE t.name = ? AND k.label = ?`,
      )
      .get(tool, label) as { id: number; oldRef: string } | null;
    if (!row) {
      throw new Error(
        `no key labelled "${label}" exists for "${tool}" — use \`stm add\` first`,
      );
    }

    const newRef = randomUUID();
    keychainSet(newRef, input.newValue);
    try {
      this.db
        .query(
          `UPDATE keys SET keychain_ref = ?, status = 'active', created_at = ? WHERE id = ?`,
        )
        .run(newRef, new Date().toISOString(), row.id);
    } catch (e) {
      // Inventory write failed — undo the keystore write so we don't
      // leak an orphan value.
      try {
        keychainDelete(newRef);
      } catch {
        /* best-effort */
      }
      throw e;
    }

    let oldRefDeleted = false;
    try {
      keychainDelete(row.oldRef);
      oldRefDeleted = true;
    } catch {
      // Old keystore entry already missing (e.g. user wiped the
      // keychain by hand) — not fatal. The inventory has been
      // repointed at newRef already.
    }
    return { newRef, oldRefDeleted };
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

  /**
   * Resolved secret values of every active key — used by the UserPromptSubmit
   * hook to block a managed secret pasted into the chat even when it is not
   * key-shaped (a plain password). Reads the keychain once per active key, so
   * callers should treat this as a per-invocation cost. Null/empty values are
   * dropped. The caller decides any length threshold.
   */
  activeKeyValues(): string[] {
    const refs = this.db
      .query(`SELECT keychain_ref FROM keys WHERE status = 'active'`)
      .all() as { keychain_ref: string }[];
    const out: string[] = [];
    for (const { keychain_ref } of refs) {
      const v = keychainGet(keychain_ref);
      if (v) out.push(v);
    }
    return out;
  }

  // ---- policies ----------------------------------------------------------

  /**
   * Insert a new policy rule. Returns the inserted rule with its assigned
   * id. Empty-string predicates are coerced to null ("match anything") since
   * an empty glob has no useful meaning at this level.
   */
  addPolicy(input: {
    ordering?: number;
    whenKey?: string | null;
    whenCommand?: string | null;
    whenAgent?: string | null;
    whenProject?: string | null;
    action: PolicyAction;
    reason?: string | null;
  }): PolicyRule {
    const norm = (s: string | null | undefined): string | null =>
      s == null || s === "" ? null : s;
    const ordering = input.ordering ?? 100;
    const r = this.db
      .query(
        `INSERT INTO policies (ordering, when_key, when_command, when_agent, when_project, action, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ordering,
        norm(input.whenKey),
        norm(input.whenCommand),
        norm(input.whenAgent),
        norm(input.whenProject),
        input.action,
        norm(input.reason),
        new Date().toISOString(),
      );
    return this.getPolicy(Number(r.lastInsertRowid))!;
  }

  getPolicy(id: number): PolicyRule | null {
    return (this.db
      .query(`SELECT * FROM policies WHERE id = ?`)
      .get(id) as PolicyRule | null) ?? null;
  }

  /** All policies in evaluation order (ordering ASC, id ASC). */
  listPolicies(): PolicyRule[] {
    return this.db
      .query(`SELECT * FROM policies ORDER BY ordering ASC, id ASC`)
      .all() as PolicyRule[];
  }

  removePolicy(id: number): boolean {
    const r = this.db.query(`DELETE FROM policies WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  // ---- audit log ---------------------------------------------------------

  /**
   * Append one row to the audit log, then prune the oldest rows if the table
   * has grown past STM_AUDIT_MAX (default 10_000).
   *
   * The CALLER is responsible for the load-bearing invariant: `command` must
   * be the un-substituted form (placeholders intact). The store enforces no
   * resolution; it just writes what it's given. See specs/audit-log.md §5.
   */
  recordAudit(input: {
    event: AuditEvent;
    tool?: string | null;
    label?: string | null;
    command?: string | null;
    agent?: string | null;
    policyId?: number | null;
    reason?: string | null;
  }): void {
    this.db
      .query(
        `INSERT INTO audit_log (ts, event, tool, label, command, agent, policy_id, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        input.event,
        input.tool ?? null,
        input.label ?? null,
        input.command ?? null,
        input.agent ?? null,
        input.policyId ?? null,
        input.reason ?? null,
      );

    const max = auditMax();
    const count = (this.db
      .query(`SELECT COUNT(*) AS c FROM audit_log`)
      .get() as { c: number }).c;
    if (count > max) {
      // Prune in one DELETE so the operation stays atomic vis-à-vis the
      // INSERT above (both inside the implicit SQLite transaction).
      this.db
        .query(
          `DELETE FROM audit_log
            WHERE id IN (SELECT id FROM audit_log ORDER BY id ASC LIMIT ?)`,
        )
        .run(Math.max(AUDIT_PRUNE_BATCH, count - max));
    }
  }

  /**
   * Most-recent-first. Defaults to 100 rows. Optional `sinceISO` filters to
   * rows newer than the given timestamp (the caller parses durations).
   */
  listAudit(opts?: {
    limit?: number;
    event?: AuditEvent;
    tool?: string;
    sinceISO?: string;
  }): AuditRow[] {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 10_000));
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts?.event) {
      clauses.push("event = ?");
      params.push(opts.event);
    }
    if (opts?.tool) {
      clauses.push("tool = ?");
      params.push(opts.tool);
    }
    if (opts?.sinceISO) {
      clauses.push("ts >= ?");
      params.push(opts.sinceISO);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    return this.db
      .query(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`)
      .all(...(params as any[])) as AuditRow[];
  }

  auditCount(): number {
    return (this.db.query(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c;
  }

  /**
   * Prune the audit log. Exactly one of `beforeISO` or `keepNewest` must be
   * provided. `beforeISO` drops rows whose `ts` is older than the cutoff;
   * `keepNewest` keeps the N most-recent rows by `id`. Returns the count of
   * rows removed.
   */
  pruneAudit(opts: { beforeISO?: string; keepNewest?: number }): number {
    if (opts.beforeISO != null) {
      const before = this.auditCount();
      this.db.query(`DELETE FROM audit_log WHERE ts < ?`).run(opts.beforeISO);
      return before - this.auditCount();
    }
    if (opts.keepNewest != null) {
      const keep = Math.max(0, Math.floor(opts.keepNewest));
      const before = this.auditCount();
      this.db
        .query(
          `DELETE FROM audit_log
            WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT ?)`,
        )
        .run(keep);
      return before - this.auditCount();
    }
    throw new Error("pruneAudit needs either beforeISO or keepNewest");
  }

  /** Delete the entire audit log. Returns the number of rows removed. */
  clearAudit(): number {
    const c = this.auditCount();
    this.db.exec(`DELETE FROM audit_log`);
    return c;
  }

  // ---- projects ----------------------------------------------------------

  /**
   * Register a project: `path` becomes the longest-prefix-match key,
   * `name` is the human-readable label shown in dashboards and guidance.
   * Returns the inserted row.
   */
  addProject(input: { path: string; name: string }): Project {
    const path = normalizeProjectPath(input.path);
    if (!path) throw new Error("project path is empty");
    const name = input.name.trim();
    if (!name) throw new Error("project name is empty");
    this.db
      .query(
        `INSERT INTO projects (path, name, created_at) VALUES (?, ?, ?)`,
      )
      .run(path, name, new Date().toISOString());
    return this.getProjectByPath(path)!;
  }

  getProject(id: number): Project | null {
    return (this.db
      .query(`SELECT * FROM projects WHERE id = ?`)
      .get(id) as Project | null) ?? null;
  }

  getProjectByPath(path: string): Project | null {
    return (this.db
      .query(`SELECT * FROM projects WHERE path = ?`)
      .get(normalizeProjectPath(path)) as Project | null) ?? null;
  }

  listProjects(): Project[] {
    return this.db
      .query(`SELECT * FROM projects ORDER BY path`)
      .all() as Project[];
  }

  /**
   * Toggle a project's scope-enforcement flag. When `on === true`, PreToolUse
   * denies any substitution whose `(tool, label)` is not in the project's
   * scope rows. Returns false if the project does not exist.
   */
  setEnforceScope(projectId: number, on: boolean): boolean {
    const r = this.db
      .query(`UPDATE projects SET enforce_scope = ? WHERE id = ?`)
      .run(on ? 1 : 0, projectId);
    return r.changes > 0;
  }

  /**
   * True when the (tool, label) pair is registered in this project's scope.
   * Used by the PreToolUse hook to decide whether a substitution is allowed
   * under scope enforcement. Reads a single row by composite key.
   */
  isInProjectScope(projectId: number, tool: string, label: string): boolean {
    const t = normalizeSegment(tool);
    const l = normalizeSegment(label);
    const toolRow = this.getTool(t);
    if (!toolRow) return false;
    const row = this.db
      .query(
        `SELECT 1 FROM project_scope
          WHERE project_id = ? AND tool_id = ? AND label = ?`,
      )
      .get(projectId, toolRow.id, l);
    return row != null;
  }

  /** Update a project's `name` only. Path is immutable; users should remove + re-add. */
  renameProject(id: number, name: string): boolean {
    const r = this.db
      .query(`UPDATE projects SET name = ? WHERE id = ?`)
      .run(name.trim(), id);
    return r.changes > 0;
  }

  removeProject(id: number): boolean {
    const r = this.db.query(`DELETE FROM projects WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  /**
   * Find the project whose `path` is the LONGEST prefix of `cwd`. A project
   * registered at `/a/b` matches a session opened in `/a/b` or `/a/b/c`, but
   * not `/a/bc` — the prefix check is `cwd === path || cwd.startsWith(path + "/")`.
   * Returns null when no project's path matches.
   */
  matchProject(cwd: string): Project | null {
    const norm = normalizeProjectPath(cwd);
    // SQLite has no clean way to do "is X a path-prefix of Y", and the row
    // count will stay small enough that scanning + filtering in JS is the
    // simpler design. ORDER BY length DESC means the first match is the
    // longest match.
    const rows = this.db
      .query(`SELECT * FROM projects ORDER BY LENGTH(path) DESC`)
      .all() as Project[];
    for (const p of rows) {
      if (norm === p.path || norm.startsWith(p.path + "/")) return p;
    }
    return null;
  }

  /**
   * Add a (tool, label) entry to a project's scope. The tool must already
   * exist (we don't auto-create — scope is over keys you've already added).
   * Duplicate entries are ignored (PRIMARY KEY conflict swallowed).
   */
  addProjectScope(projectId: number, tool: string, label: string): void {
    const t = normalizeSegment(tool);
    const l = normalizeSegment(label);
    const toolRow = this.getTool(t);
    if (!toolRow) throw new Error(`unknown tool: ${tool}`);
    this.db
      .query(
        `INSERT OR IGNORE INTO project_scope (project_id, tool_id, label)
         VALUES (?, ?, ?)`,
      )
      .run(projectId, toolRow.id, l);
  }

  removeProjectScope(projectId: number, tool: string, label: string): boolean {
    const t = normalizeSegment(tool);
    const l = normalizeSegment(label);
    const toolRow = this.getTool(t);
    if (!toolRow) return false;
    const r = this.db
      .query(
        `DELETE FROM project_scope
          WHERE project_id = ? AND tool_id = ? AND label = ?`,
      )
      .run(projectId, toolRow.id, l);
    return r.changes > 0;
  }

  /** Every (tool, label) pair in a project's scope, in stable order. */
  projectScope(projectId: number): ProjectScopeEntry[] {
    const rows = this.db
      .query(
        `SELECT t.name AS tool, ps.label AS label
           FROM project_scope ps
           JOIN tools t ON t.id = ps.tool_id
          WHERE ps.project_id = ?
          ORDER BY t.name, ps.label`,
      )
      .all(projectId) as { tool: string; label: string }[];
    return rows.map((r) => ({
      tool: r.tool,
      label: r.label,
      placeholder: makePlaceholder(r.tool, r.label),
    }));
  }
}
