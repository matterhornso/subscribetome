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
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as edVerify } from "node:crypto";

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
CREATE TABLE IF NOT EXISTS members (
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  member_id   TEXT NOT NULL,
  pubkey      TEXT NOT NULL,   -- X25519 sealing public key (receives the team key)
  sign_pubkey TEXT,            -- Ed25519 signing public key (attributes usage)
  wrapped_key TEXT,            -- the sealed team-key envelope; null while pending
  added_at    TEXT NOT NULL,
  PRIMARY KEY (team_id, member_id)
);
`;

/** Max encrypted-vault size the server will accept (10 MiB) — a team vault is
 *  a small JSON of key references; this just bounds abuse. */
const MAX_VAULT_BYTES = 10 * 1024 * 1024;
/** Overall request-body ceiling (Bun.serve), a hair above the vault cap. */
const MAX_REQUEST_BODY = 12 * 1024 * 1024;
/** Per-endpoint bounds so audit/members can't fill the disk or OOM the host. */
const MAX_AUDIT_ROWS_PER_REQUEST = 1000;
const MAX_AUDIT_FIELD = 8192; // event / actor / detail / ts
const MAX_PUBKEY_CHARS = 2048; // SPKI X25519 base64 is ~60 chars; generous
const MAX_ENVELOPE_CHARS = 65536; // sealed JSON envelope

function sha256hex(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

/** The member-id fingerprint of a member's TWO public keys. MUST match
 *  keypair.ts `memberIdFor` (sha256 of sealBytes||signBytes, first 32 hex = 128b).
 *  The server enforces this binding so a member can't register a key set under
 *  someone else's id — for either the sealing or the signing key. */
function memberIdForKeys(sealPubB64: string, signPubB64: string): string {
  return sha256hex(
    Buffer.concat([Buffer.from(sealPubB64, "base64"), Buffer.from(signPubB64, "base64")]),
  ).slice(0, 32);
}

/** Verify an Ed25519 signature (base64) over `payload` with an SPKI-DER pubkey
 *  (base64). Pure node:crypto — the server has no keychain dependency. */
function verifyEd25519(payload: Buffer, sigB64: string, pubB64: string): boolean {
  try {
    const pub = createPublicKey({ key: Buffer.from(pubB64, "base64"), format: "der", type: "spki" });
    return edVerify(null, payload, pub, Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

/** Signature freshness window + replay-nonce TTL (5 min). */
const SIG_WINDOW_MS = 5 * 60 * 1000;

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
    // Additive migration: a members table created before signing existed lacks
    // sign_pubkey. ALTER is idempotent-guarded so fresh DBs (schema already has
    // it) are untouched.
    const cols = this.db.query(`PRAGMA table_info(members)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "sign_pubkey")) {
      this.db.exec(`ALTER TABLE members ADD COLUMN sign_pubkey TEXT`);
    }
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
    // Read-then-write the version in ONE transaction so two concurrent PUTs
    // can't compute the same version and collide on the PRIMARY KEY.
    const tx = this.db.transaction((): number => {
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
    });
    return tx();
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
    // Cap rows-per-request and field lengths so a single call can't flood the
    // table or store multi-MB fields.
    const clip = (s: unknown): string | null =>
      typeof s === "string" ? s.slice(0, MAX_AUDIT_FIELD) : null;
    let n = 0;
    const tx = this.db.transaction((rs: typeof rows) => {
      for (const r of rs.slice(0, MAX_AUDIT_ROWS_PER_REQUEST)) {
        if (!r || typeof r.event !== "string" || !r.event) continue;
        insert.run(
          teamId,
          clip(r.ts) ?? new Date().toISOString(),
          clip(r.actor),
          clip(r.event)!,
          clip(r.detail),
        );
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

  /** Register (or refresh) a member's sealing + signing public keys. Leaves any
   *  existing sealed envelope intact; a brand-new member starts pending. */
  registerMember(teamId: number, memberId: string, sealPubkey: string, signPubkey: string): void {
    this.db
      .query(
        `INSERT INTO members (team_id, member_id, pubkey, sign_pubkey, wrapped_key, added_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(team_id, member_id) DO UPDATE SET
           pubkey = excluded.pubkey, sign_pubkey = excluded.sign_pubkey`,
      )
      .run(teamId, memberId, sealPubkey, signPubkey, new Date().toISOString());
  }

  /** Record the sealed team-key envelope for a member (enroll them). */
  setMemberEnvelope(teamId: number, memberId: string, envelope: string): boolean {
    const r = this.db
      .query(`UPDATE members SET wrapped_key = ? WHERE team_id = ? AND member_id = ?`)
      .run(envelope, teamId, memberId);
    return r.changes > 0;
  }

  getMember(teamId: number, memberId: string): { member_id: string; pubkey: string; sign_pubkey: string | null; wrapped_key: string | null } | null {
    return (
      (this.db
        .query(`SELECT member_id, pubkey, sign_pubkey, wrapped_key FROM members WHERE team_id = ? AND member_id = ?`)
        .get(teamId, memberId) as any) ?? null
    );
  }

  listMembers(teamId: number): { memberId: string; pubkey: string; enrolled: boolean }[] {
    const rows = this.db
      .query(`SELECT member_id, pubkey, wrapped_key FROM members WHERE team_id = ? ORDER BY added_at ASC`)
      .all(teamId) as { member_id: string; pubkey: string; wrapped_key: string | null }[];
    return rows.map((r) => ({ memberId: r.member_id, pubkey: r.pubkey, enrolled: r.wrapped_key != null }));
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
  // Per-server replay cache: (memberId:nonce) -> expiry. In-memory is fine — the
  // window is 5 min and a restart only widens the replay gap, never narrows it.
  const seenNonces = new Map<string, number>();

  /**
   * Verify a member signature over the request. Returns the VERIFIED memberId
   * (never client-supplied) or null. Canonical payload:
   *   method \n path \n timestamp \n nonce \n sha256hex(body)
   * Requires the member exists with a registered signing key, a fresh timestamp,
   * and an unused nonce.
   */
  function verifyMemberSignature(
    teamId: number,
    method: string,
    path: string,
    bodyBytes: Buffer,
    req: Request,
  ): string | null {
    const memberId = req.headers.get("x-stm-member") ?? "";
    const ts = req.headers.get("x-stm-timestamp") ?? "";
    const nonce = req.headers.get("x-stm-nonce") ?? "";
    const sig = req.headers.get("x-stm-signature") ?? "";
    if (!memberId || !ts || !nonce || !sig) return null;
    const t = Date.parse(ts);
    if (!Number.isFinite(t) || Math.abs(Date.now() - t) > SIG_WINDOW_MS) return null;
    const cacheKey = `${memberId}:${nonce}`;
    const now = Date.now();
    if (seenNonces.size > 10000) for (const [k, exp] of seenNonces) if (exp < now) seenNonces.delete(k);
    if (seenNonces.has(cacheKey)) return null; // replay
    const mem = store.getMember(teamId, memberId);
    if (!mem || !mem.sign_pubkey) return null;
    const canonical = Buffer.from(
      `${method}\n${path}\n${ts}\n${nonce}\n${sha256hex(bodyBytes)}`,
      "utf8",
    );
    if (!verifyEd25519(canonical, sig, mem.sign_pubkey)) return null;
    seenNonces.set(cacheKey, now + SIG_WINDOW_MS);
    return memberId;
  }

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
    if (
      path.startsWith("/v1/vault") ||
      path.startsWith("/v1/audit") ||
      path.startsWith("/v1/members")
    ) {
      if (!team) return json({ error: "unauthorized" }, 401);
    }

    // --- member enrollment (public-key key distribution) ---
    if (path === "/v1/members" && method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      const sealPubkey = typeof b?.pubkey === "string" ? b.pubkey : "";
      const signPubkey = typeof b?.signPubkey === "string" ? b.signPubkey : "";
      if (typeof b?.memberId !== "string" || !b.memberId || !sealPubkey || !signPubkey) {
        return json({ error: "memberId, pubkey, and signPubkey are required" }, 400);
      }
      if (sealPubkey.length > MAX_PUBKEY_CHARS || signPubkey.length > MAX_PUBKEY_CHARS) {
        return json({ error: "pubkey too large" }, 413);
      }
      // Enforce the self-certifying binding: the member id MUST be the fingerprint
      // of BOTH keys. This stops a token-holder from registering their own key
      // under another member's id (identity substitution → team-key theft), for
      // either the sealing or the signing key. Also constrains memberId to hex.
      if (memberIdForKeys(sealPubkey, signPubkey) !== b.memberId) {
        return json({ error: "memberId does not match sha256(sealPubkey||signPubkey) — rejected" }, 400);
      }
      store.registerMember(team!.id, b.memberId, sealPubkey, signPubkey);
      return json({ ok: true });
    }
    if (path === "/v1/members" && method === "GET") {
      return json({ members: store.listMembers(team!.id) });
    }
    {
      const m = path.match(/^\/v1\/members\/([A-Za-z0-9_-]+)\/envelope$/);
      if (m) {
        const memberId = m[1];
        if (method === "POST") {
          const b: any = await req.json().catch(() => ({}));
          if (typeof b?.envelope !== "string" || !b.envelope) {
            return json({ error: "envelope is required" }, 400);
          }
          if (b.envelope.length > MAX_ENVELOPE_CHARS) return json({ error: "envelope too large" }, 413);
          return store.setMemberEnvelope(team!.id, memberId, b.envelope)
            ? json({ ok: true })
            : json({ error: "no such member — they must enroll-request first" }, 404);
        }
        if (method === "GET") {
          const mem = store.getMember(team!.id, memberId);
          if (!mem) return json({ error: "no such member" }, 404);
          if (!mem.wrapped_key) return json({ error: "not enrolled yet — ask an admin to enroll you" }, 404);
          return json({ envelope: mem.wrapped_key, pubkey: mem.pubkey, signPubkey: mem.sign_pubkey });
        }
      }
    }
    {
      const m = path.match(/^\/v1\/members\/([A-Za-z0-9_-]+)$/);
      if (m && method === "GET") {
        const mem = store.getMember(team!.id, m[1]);
        return mem
          ? json({ memberId: mem.member_id, pubkey: mem.pubkey, signPubkey: mem.sign_pubkey, enrolled: mem.wrapped_key != null })
          : json({ error: "no such member" }, 404);
      }
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
      // Read raw bytes first — the signature is over the exact body.
      const bytes = Buffer.from(await req.arrayBuffer());
      // Require a valid member signature; the ACTOR is the verified memberId,
      // never a client-supplied string. This is what makes "who used which key"
      // trustworthy instead of forgeable.
      const actor = verifyMemberSignature(team!.id, "POST", "/v1/audit", bytes, req);
      if (!actor) return json({ error: "a valid member signature is required (X-STM-Member/Timestamp/Nonce/Signature)" }, 401);
      let b: any = {};
      try { b = JSON.parse(bytes.toString("utf8") || "{}"); } catch { b = {}; }
      const rows = Array.isArray(b?.rows) ? b.rows : [];
      // Stamp every row with the verified actor, overriding anything the client sent.
      const stamped = rows.map((r: any) => ({ ...r, actor }));
      const added = store.appendAudit(team!.id, stamped);
      return json({ ok: true, added, actor });
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
  // Bound the request body at the transport layer so an oversized POST is
  // refused before it is buffered (defends the vault/audit/member endpoints).
  const server = Bun.serve({ hostname, port, maxRequestBodySize: MAX_REQUEST_BODY, fetch: handler });

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
