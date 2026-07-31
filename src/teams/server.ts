// STM Teams — the self-hostable sync server.
//
// A team runs THIS on their own infrastructure. It is deliberately dumb and
// ZERO-KNOWLEDGE: it stores an opaque encrypted vault blob plus an audit log,
// and it can never read a credential. The team's vault is encrypted on a
// member's machine (AES-256-GCM, the same primitive as the local encrypted-file
// keystore) with a team key the server never receives. The server only ever
// holds ciphertext + metadata.
//
// This keeps STM's trust story intact as it grows into a team product: even a
// fully-compromised Teams server (stolen DB, malicious host) yields no key —
// only blobs it structurally cannot decrypt.
//
// Auth model (v1, intentionally minimal):
//   - An ADMIN token (set when the server starts) is required to create a team.
//     Without it, team creation is disabled — a misconfigured public server
//     can't be filled with teams by strangers.
//   - Each team gets its own bearer TOKEN at creation. It is stored only as a
//     SHA-256 hash, so a leaked database does not reveal live tokens. That
//     token authorizes vault + audit for that team only.
//
// The server is transport-agnostic about TLS: run it behind a reverse proxy
// (caddy/nginx) for HTTPS, or bind localhost for a single-machine trial.
import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_blobs (
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  ciphertext  BLOB NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT,
  PRIMARY KEY (team_id, version)
);
CREATE TABLE IF NOT EXISTS team_audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id  INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  ts       TEXT NOT NULL,
  actor    TEXT,
  event    TEXT NOT NULL,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS team_audit_idx ON team_audit(team_id, id DESC);
`;

/** Max encrypted-vault size the server will accept (10 MiB) — a team vault is
 *  a small JSON of key references; this just bounds abuse. */
const MAX_VAULT_BYTES = 10 * 1024 * 1024;

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Constant-time string compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface TeamRow {
  id: number;
  name: string;
  created_at: string;
}

export class TeamServerStore {
  private db: Database;
  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  /** Create a team; returns its id + a freshly-minted bearer token (shown once).
   *  The token is stored only as a hash. */
  createTeam(name: string): { id: number; token: string } {
    const token = randomBytes(24).toString("hex");
    const info = this.db
      .query(
        `INSERT INTO teams (name, token_hash, created_at) VALUES (?, ?, ?) RETURNING id`,
      )
      .get(name, sha256hex(token), new Date().toISOString()) as { id: number };
    return { id: info.id, token };
  }

  teamByToken(token: string): TeamRow | null {
    if (!token) return null;
    return (
      (this.db
        .query(`SELECT id, name, created_at FROM teams WHERE token_hash = ?`)
        .get(sha256hex(token)) as TeamRow | undefined) ?? null
    );
  }

  putVault(teamId: number, ciphertext: Uint8Array, updatedBy: string | null): number {
    const row = this.db
      .query(`SELECT COALESCE(MAX(version), 0) AS v FROM vault_blobs WHERE team_id = ?`)
      .get(teamId) as { v: number };
    const version = row.v + 1;
    this.db
      .query(
        `INSERT INTO vault_blobs (team_id, version, ciphertext, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(teamId, version, ciphertext, new Date().toISOString(), updatedBy);
    return version;
  }

  getVault(teamId: number): { version: number; ciphertext: Uint8Array; updated_at: string } | null {
    const row = this.db
      .query(
        `SELECT version, ciphertext, updated_at FROM vault_blobs
          WHERE team_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(teamId) as { version: number; ciphertext: Uint8Array; updated_at: string } | undefined;
    return row ?? null;
  }

  appendAudit(
    teamId: number,
    rows: { ts?: string; actor?: string; event: string; detail?: string }[],
  ): number {
    const insert = this.db.query(
      `INSERT INTO team_audit (team_id, ts, actor, event, detail) VALUES (?, ?, ?, ?, ?)`,
    );
    let n = 0;
    const tx = this.db.transaction((rs: typeof rows) => {
      for (const r of rs) {
        if (!r || typeof r.event !== "string" || !r.event) continue;
        insert.run(teamId, r.ts ?? new Date().toISOString(), r.actor ?? null, r.event, r.detail ?? null);
        n++;
      }
    });
    tx(rows);
    return n;
  }

  listAudit(teamId: number, limit: number): { ts: string; actor: string | null; event: string; detail: string | null }[] {
    return this.db
      .query(
        `SELECT ts, actor, event, detail FROM team_audit
          WHERE team_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(teamId, limit) as any[];
  }

  close(): void {
    this.db.close();
  }
}

const SEC_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...SEC_HEADERS },
  });
}

function bearer(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

export interface TeamServerOptions {
  store: TeamServerStore;
  /** Required to create a team. If empty/undefined, team creation is disabled. */
  adminToken?: string;
}

/**
 * Build the request handler. Exposed separately from `runTeamServer` so tests
 * can drive it with plain Request objects (no port bind).
 */
export function makeTeamServerHandler(
  opts: TeamServerOptions,
): (req: Request) => Promise<Response> {
  const { store, adminToken } = opts;

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (path === "/v1/health") return json({ ok: true });

    // --- team creation (admin only) ---
    if (path === "/v1/teams" && method === "POST") {
      if (!adminToken) return json({ error: "team creation disabled (no admin token configured)" }, 403);
      if (!safeEqual(bearer(req), adminToken)) return json({ error: "unauthorized" }, 401);
      const b: any = await req.json().catch(() => ({}));
      const name = typeof b?.name === "string" ? b.name.trim() : "";
      if (!name) return json({ error: "name is required" }, 400);
      const { id, token } = store.createTeam(name);
      return json({ id, name, token });
    }

    // --- everything below is team-token authenticated ---
    const team = store.teamByToken(bearer(req));
    if (path.startsWith("/v1/vault") || path.startsWith("/v1/audit")) {
      if (!team) return json({ error: "unauthorized" }, 401);
    }

    if (path === "/v1/vault" && method === "PUT") {
      const buf = new Uint8Array(await req.arrayBuffer());
      if (buf.byteLength === 0) return json({ error: "empty vault body" }, 400);
      if (buf.byteLength > MAX_VAULT_BYTES) return json({ error: "vault too large" }, 413);
      const version = store.putVault(team!.id, buf, req.headers.get("x-stm-actor"));
      return json({ ok: true, version });
    }

    if (path === "/v1/vault" && method === "GET") {
      const v = store.getVault(team!.id);
      if (!v) return json({ error: "no vault yet" }, 404);
      return new Response(v.ciphertext, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "x-stm-vault-version": String(v.version),
          "x-stm-vault-updated": v.updated_at,
          ...SEC_HEADERS,
        },
      });
    }

    if (path === "/v1/audit" && method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      const rows = Array.isArray(b?.rows) ? b.rows : [];
      const added = store.appendAudit(team!.id, rows);
      return json({ ok: true, added });
    }

    if (path === "/v1/audit" && method === "GET") {
      const raw = Number(url.searchParams.get("limit") ?? "100");
      const limit = Number.isFinite(raw) ? Math.max(1, Math.min(Math.floor(raw), 1000)) : 100;
      return json({ rows: store.listAudit(team!.id, limit) });
    }

    return json({ error: "not found" }, 404);
  };
}

/** Start the self-hostable Teams server (the `stm teams serve` entry). */
export async function runTeamServer(config?: {
  dbPath?: string;
  hostname?: string;
  port?: number;
  adminToken?: string;
}): Promise<void> {
  const dbPath = config?.dbPath ?? process.env.STM_TEAM_DB ?? "stm-teams.sqlite";
  const hostname = config?.hostname ?? process.env.STM_TEAM_HOST ?? "127.0.0.1";
  const port = config?.port ?? Number(process.env.STM_TEAM_PORT ?? "8787");
  const adminToken = config?.adminToken ?? process.env.STM_TEAM_ADMIN_TOKEN ?? "";

  const store = new TeamServerStore(dbPath);
  const handler = makeTeamServerHandler({ store, adminToken });
  const server = Bun.serve({ hostname, port, fetch: handler });

  process.stderr.write(
    `stm teams server on http://${hostname}:${server.port}  (db: ${dbPath})\n` +
      (adminToken
        ? `team creation ENABLED (admin token set)\n`
        : `team creation DISABLED — set STM_TEAM_ADMIN_TOKEN to create teams\n`),
  );

  const shutdown = () => {
    server.stop(true);
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
