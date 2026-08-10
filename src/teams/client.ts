// STM Teams — client side. Config, the team key, and encrypted vault sync.
//
// The trust boundary: the team's credentials are encrypted on THIS machine with
// a team passphrase the server never sees, then pushed as an opaque blob. A
// teammate pulls the blob and decrypts locally. The server stores ciphertext;
// only members holding the passphrase can read it.
//
// Local state:
//   - server URL + team bearer token -> ~/.subscribetome/teams.json (0600)
//   - the team passphrase (the actual encryption key) -> the OS keychain, never
//     on disk in plaintext. Shared between teammates out-of-band (v1).
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { encryptVault, decryptVault } from "../keystores/encrypted-file.ts";
import { keychainGet, keychainSet, keychainDelete } from "../keychain.ts";
import { DATA_DIR, ensureDataDir } from "../paths.ts";
import type { Store } from "../store.ts";

/** Resolved at call time (like keychainService) so STM_TEAM_CONFIG can be
 *  overridden in tests without a module-load race. */
function teamConfigFile(): string {
  return process.env.STM_TEAM_CONFIG || join(DATA_DIR, "teams.json");
}
/** Reserved keychain ref for the team passphrase (not a normal key placeholder). */
const TEAM_PASSPHRASE_REF = "__stm_team_passphrase__";
/** Current team-vault payload format. */
const TEAM_VAULT_VERSION = 1 as const;

export interface TeamConfig {
  /** Base URL of the self-hosted server, e.g. https://teams.example.com */
  serverUrl: string;
  /** Team bearer token (authorizes vault + audit for this team). */
  teamToken: string;
  teamId?: number;
  teamName?: string;
  /** Highest local audit-row id already pushed to the team log (sync cursor). */
  auditCursor?: number;
  /** Highest local usage-row id already pushed to the team usage log (cursor). */
  usageCursor?: number;
  /**
   * Public fingerprint of the team key, obtained OUT-OF-BAND (never from the
   * server — it is untrusted). `accept` checks the key it unwraps from the
   * server's envelope against this before trusting it, so a malicious server
   * cannot substitute a key it knows. Reveals nothing about the key itself.
   */
  teamKeyFp?: string;
}

export interface TeamVaultPayload {
  stmTeamVault: typeof TEAM_VAULT_VERSION;
  updatedAt: string;
  keys: { tool: string; label: string; value: string }[];
}

// ---- local config + passphrase (multi-team, M4b) ------------------------

/** Current teams.json container format. */
const TEAMS_FORMAT = 2 as const;

/** A locally-named team: the on-disk TeamConfig plus a stable local handle used
 *  by `--team <name>` and `stm teams use`. */
export interface TeamRecord extends TeamConfig {
  name: string;
}

interface TeamsFile {
  stmTeams: typeof TEAMS_FORMAT;
  current: string | null;
  teams: TeamRecord[];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "team";
}
function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let i = 2;
  while (taken.includes(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
function isTeamConfigShape(x: any): boolean {
  return x && typeof x.serverUrl === "string" && typeof x.teamToken === "string";
}

/**
 * Pure: normalize any parsed `teams.json` into the multi-team container.
 * Handles three inputs — the current container, the LEGACY single-TeamConfig
 * file (wrapped into a one-team container, made current), and empty/garbage
 * (an empty container). Exported so the migration is unit-testable off-disk.
 */
export function migrateTeamsData(raw: any): TeamsFile {
  if (raw && raw.stmTeams === TEAMS_FORMAT && Array.isArray(raw.teams)) {
    const taken: string[] = [];
    const teams: TeamRecord[] = [];
    for (const t of raw.teams) {
      if (!isTeamConfigShape(t)) continue;
      const name = uniqueName(typeof t.name === "string" && t.name ? slug(t.name) : slug(t.teamName || "team"), taken);
      taken.push(name);
      teams.push({ ...t, name });
    }
    const current = typeof raw.current === "string" && teams.some((t) => t.name === raw.current) ? raw.current : teams[0]?.name ?? null;
    return { stmTeams: TEAMS_FORMAT, current, teams };
  }
  if (isTeamConfigShape(raw)) {
    const name = slug(raw.teamName || (raw.teamId ? `team-${raw.teamId}` : "team"));
    return { stmTeams: TEAMS_FORMAT, current: name, teams: [{ ...raw, name }] };
  }
  return { stmTeams: TEAMS_FORMAT, current: null, teams: [] };
}

function readTeamsFile(): TeamsFile {
  try {
    return migrateTeamsData(JSON.parse(readFileSync(teamConfigFile(), "utf8")));
  } catch {
    return { stmTeams: TEAMS_FORMAT, current: null, teams: [] };
  }
}

function writeTeamsFile(f: TeamsFile): void {
  ensureDataDir();
  // Unlink then write 0600 (umask only clears bits). The dir is 0700, so there
  // is no readable window; the file holds only shareable bearer tokens, never a
  // team key.
  try { unlinkSync(teamConfigFile()); } catch { /* absent */ }
  writeFileSync(teamConfigFile(), JSON.stringify(f, null, 2), { mode: 0o600 });
  try { chmodSync(teamConfigFile(), 0o600); } catch { /* non-POSIX */ }
}

/** The active team (or a named one). Returns a TeamRecord (carries `.name`). */
export function readTeamConfig(handle?: string): TeamConfig | null {
  const f = readTeamsFile();
  const name = handle ?? f.current;
  const rec = f.teams.find((t) => t.name === name) ?? (handle == null ? f.teams[0] : undefined);
  return rec ?? null;
}

/** Upsert a team record (by its `.name`, or an explicit handle). Used both to
 *  add a team and to persist cursor/fingerprint updates for an existing one. */
export function writeTeamConfig(cfg: TeamConfig, handle?: string): void {
  const f = readTeamsFile();
  const name = handle ?? (cfg as TeamRecord).name ?? f.current ?? uniqueName(slug(cfg.teamName || "team"), f.teams.map((t) => t.name));
  const rec: TeamRecord = { ...(cfg as any), name };
  const idx = f.teams.findIndex((t) => t.name === name);
  if (idx >= 0) f.teams[idx] = rec;
  else f.teams.push(rec);
  if (f.current == null) f.current = name;
  writeTeamsFile(f);
}

export function teamConfigured(): boolean {
  return readTeamsFile().teams.length > 0;
}

/** All teams this machine belongs to, current-flagged. */
export function listTeams(): { name: string; current: boolean; serverUrl: string; teamName?: string; teamId?: number }[] {
  const f = readTeamsFile();
  return f.teams.map((t) => ({ name: t.name, current: t.name === f.current, serverUrl: t.serverUrl, teamName: t.teamName, teamId: t.teamId }));
}

export function currentTeamName(): string | null {
  return readTeamsFile().current;
}

/** Switch the active team. False if no such local name. */
export function useTeam(handle: string): boolean {
  const f = readTeamsFile();
  if (!f.teams.some((t) => t.name === handle)) return false;
  f.current = handle;
  writeTeamsFile(f);
  return true;
}

/** Add a team and make it current; returns the assigned local handle. */
export function addTeam(cfg: TeamConfig, desiredName?: string): string {
  const f = readTeamsFile();
  const name = uniqueName(slug(desiredName || cfg.teamName || (cfg.teamId ? `team-${cfg.teamId}` : "team")), f.teams.map((t) => t.name));
  f.teams.push({ ...cfg, name });
  f.current = name;
  writeTeamsFile(f);
  return name;
}

/** Remove a team + its stored passphrase. If it was current, pick another. */
export function removeTeam(handle: string): boolean {
  const f = readTeamsFile();
  const before = f.teams.length;
  f.teams = f.teams.filter((t) => t.name !== handle);
  if (f.teams.length === before) return false;
  if (f.current === handle) f.current = f.teams[0]?.name ?? null;
  writeTeamsFile(f);
  try { keychainDelete(passphraseRef(handle)); } catch { /* absent */ }
  return true;
}

/**
 * One-time keychain migration: an old single-team file kept its team key under
 * the shared ref. Once the file is rewritten as a container, move that key to
 * the migrated team's per-team ref so `push`/`pull` keep working. Idempotent —
 * after the first run the file is container-format and this is a no-op.
 */
export function ensureTeamsMigrated(): void {
  let raw: any = null;
  try { raw = JSON.parse(readFileSync(teamConfigFile(), "utf8")); } catch { return; }
  if (!raw || raw.stmTeams === TEAMS_FORMAT || !isTeamConfigShape(raw)) return; // not a legacy file
  const f = migrateTeamsData(raw);
  writeTeamsFile(f);
  if (f.current) {
    const legacy = keychainGet(TEAM_PASSPHRASE_REF);
    if (legacy != null) {
      keychainSet(passphraseRef(f.current), legacy);
      try { keychainDelete(TEAM_PASSPHRASE_REF); } catch { /* best-effort */ }
    }
  }
}

function passphraseRef(handle: string): string {
  return `${TEAM_PASSPHRASE_REF}${handle}`;
}

/** Store a team's passphrase (team key) in the OS keychain, per team. */
export function setTeamPassphrase(passphrase: string, handle?: string): void {
  const name = handle ?? currentTeamName();
  keychainSet(name ? passphraseRef(name) : TEAM_PASSPHRASE_REF, passphrase);
}

export function getTeamPassphrase(handle?: string): string | null {
  const name = handle ?? currentTeamName();
  if (name) {
    const v = keychainGet(passphraseRef(name));
    if (v != null) return v;
  }
  // Legacy fallback: a pre-multi-team single passphrase not yet migrated.
  return keychainGet(TEAM_PASSPHRASE_REF);
}

/** A fresh high-entropy team key, used as the vault-encryption passphrase and
 *  distributed to members by sealing it to their public keys. */
export function generateTeamKey(): string {
  return randomBytes(32).toString("base64");
}

/**
 * A PUBLIC, non-secret commitment to the team key: a domain-separated SHA-256,
 * truncated to 128 bits and grouped for read-aloud. Given a 256-bit key it
 * reveals nothing about the key, but binds it — two different keys almost never
 * share a fingerprint. Members compare this out-of-band so `accept` can reject a
 * key an untrusted server tried to substitute (see TeamConfig.teamKeyFp).
 */
export function teamKeyFingerprint(teamKey: string): string {
  const h = createHash("sha256").update("stm-team-key-fp:v1\n").update(teamKey, "utf8").digest("hex");
  return (h.slice(0, 32).match(/.{4}/g) as string[]).join("-");
}

/** True iff `teamKey` matches `expectedFp` (a fingerprint from teamKeyFingerprint).
 *  Case/format tolerant on the caller-supplied side: strips spaces + lowercases. */
export function teamKeyMatchesFingerprint(teamKey: string, expectedFp: string): boolean {
  const norm = (s: string) => s.replace(/[\s-]/g, "").toLowerCase();
  return norm(teamKeyFingerprint(teamKey)) === norm(expectedFp);
}

/** Leave one team (the current one, or a named one): drop its record + key.
 *  Returns false if there is no such team. Other teams are untouched. */
export function clearTeam(handle?: string): boolean {
  const name = handle ?? currentTeamName();
  if (!name) return false;
  return removeTeam(name);
}

// ---- server calls -------------------------------------------------------

type Fetch = typeof fetch;

/** Create a team on the server (needs the server's admin token). */
export async function createTeam(
  serverUrl: string,
  adminToken: string,
  name: string,
  deps?: { fetch?: Fetch },
): Promise<{ id: number; name: string; token: string }> {
  const doFetch = deps?.fetch ?? fetch;
  const r = await doFetch(`${trim(serverUrl)}/v1/teams`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`create team failed: HTTP ${r.status} ${await safeText(r)}`);
  return (await r.json()) as { id: number; name: string; token: string };
}

/**
 * Encrypt the local active keys with the team passphrase and push the blob.
 * The plaintext never leaves this process; the server receives ciphertext.
 */
export async function pushVault(deps: {
  store: Store;
  cfg: TeamConfig;
  passphrase: string;
  actor?: string;
  /** Share ALL active keys, ignoring per-key scope (the explicit opt-out of
   *  personal-by-default). Without it, only keys marked `shared` are pushed. */
  all?: boolean;
  fetch?: Fetch;
}): Promise<{ version: number; keyCount: number; heldBack: number }> {
  const doFetch = deps.fetch ?? fetch;
  const keys: TeamVaultPayload["keys"] = [];
  let heldBack = 0;
  for (const k of deps.store.listKeys()) {
    if (k.status !== "active") continue;
    // Personal-by-default: an unscoped or `personal` key is NOT shared unless
    // the caller explicitly opts into sharing everything.
    if (!deps.all && k.team_scope !== "shared") { heldBack++; continue; }
    const value = deps.store.resolve(k.tool, k.label);
    if (value == null) continue; // unresolved locally — skip rather than push a hole
    keys.push({ tool: k.tool, label: k.label, value });
  }
  const payload: TeamVaultPayload = {
    stmTeamVault: TEAM_VAULT_VERSION,
    updatedAt: new Date().toISOString(),
    keys,
  };
  const ciphertext = encryptVault(JSON.stringify(payload), deps.passphrase);
  const r = await doFetch(`${trim(deps.cfg.serverUrl)}/v1/vault`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${deps.cfg.teamToken}`,
      "content-type": "application/octet-stream",
      ...(deps.actor ? { "x-stm-actor": deps.actor } : {}),
    },
    body: ciphertext,
  });
  if (!r.ok) throw new Error(`push failed: HTTP ${r.status} ${await safeText(r)}`);
  const { version } = (await r.json()) as { version: number };
  return { version, keyCount: keys.length, heldBack };
}

/**
 * Pull the team vault, decrypt locally, and add any keys not already present.
 * Existing (tool,label) pairs are left untouched (no silent overwrite).
 */
export async function pullVault(deps: {
  store: Store;
  cfg: TeamConfig;
  passphrase: string;
  fetch?: Fetch;
}): Promise<{ version: number | null; added: number; skipped: number }> {
  const doFetch = deps.fetch ?? fetch;
  const r = await doFetch(`${trim(deps.cfg.serverUrl)}/v1/vault`, {
    headers: { authorization: `Bearer ${deps.cfg.teamToken}` },
  });
  if (r.status === 404) return { version: null, added: 0, skipped: 0 };
  if (!r.ok) throw new Error(`pull failed: HTTP ${r.status} ${await safeText(r)}`);
  const version = Number(r.headers.get("x-stm-vault-version") ?? "0") || null;
  const bytes = Buffer.from(await r.arrayBuffer());
  let payload: TeamVaultPayload;
  try {
    payload = JSON.parse(decryptVault(bytes, deps.passphrase)) as TeamVaultPayload;
  } catch {
    throw new Error("could not decrypt the team vault — is your team passphrase correct?");
  }
  if (payload?.stmTeamVault !== TEAM_VAULT_VERSION || !Array.isArray(payload.keys)) {
    throw new Error("team vault format not recognized");
  }
  let added = 0;
  let skipped = 0;
  for (const k of payload.keys) {
    if (!k || typeof k.tool !== "string" || typeof k.label !== "string" || typeof k.value !== "string") {
      skipped++;
      continue;
    }
    try {
      deps.store.addKey({ tool: k.tool, label: k.label, value: k.value, source: "team" });
      // A key received from the team vault is inherently shared — mark it so a
      // later `push` keeps sharing it (personal-by-default only holds back keys
      // the member never chose to share).
      deps.store.setKeyScope(k.tool, k.label, "shared");
      added++;
    } catch {
      skipped++; // already present (UNIQUE) or invalid — leave the local copy alone
    }
  }
  return { version, added, skipped };
}

// ---- public-key enrollment -----------------------------------------------

/** Register (or refresh) a member's sealing + signing public keys with the team
 *  (pending until an existing member seals the team key to it). */
export async function registerMember(
  cfg: TeamConfig,
  memberId: string,
  sealPubkey: string,
  signPubkey: string,
  deps?: { fetch?: Fetch },
): Promise<void> {
  const doFetch = deps?.fetch ?? fetch;
  const r = await doFetch(`${trim(cfg.serverUrl)}/v1/members`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.teamToken}`, "content-type": "application/json" },
    body: JSON.stringify({ memberId, pubkey: sealPubkey, signPubkey }),
  });
  if (!r.ok) throw new Error(`enroll-request failed: HTTP ${r.status} ${await safeText(r)}`);
}

export async function listMembers(
  cfg: TeamConfig,
  deps?: { fetch?: Fetch },
): Promise<{ memberId: string; pubkey: string; enrolled: boolean }[]> {
  const doFetch = deps?.fetch ?? fetch;
  const r = await doFetch(`${trim(cfg.serverUrl)}/v1/members`, {
    headers: { authorization: `Bearer ${cfg.teamToken}` },
  });
  if (!r.ok) throw new Error(`list members failed: HTTP ${r.status} ${await safeText(r)}`);
  return ((await r.json()) as any).members ?? [];
}

export async function getMember(
  cfg: TeamConfig,
  memberId: string,
  deps?: { fetch?: Fetch },
): Promise<{ memberId: string; pubkey: string; signPubkey: string | null; enrolled: boolean } | null> {
  const doFetch = deps?.fetch ?? fetch;
  const r = await doFetch(`${trim(cfg.serverUrl)}/v1/members/${encodeURIComponent(memberId)}`, {
    headers: { authorization: `Bearer ${cfg.teamToken}` },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`get member failed: HTTP ${r.status} ${await safeText(r)}`);
  return (await r.json()) as any;
}

/** Upload the sealed team-key envelope for a member (enroll them). */
export async function uploadEnvelope(
  cfg: TeamConfig,
  memberId: string,
  envelope: string,
  deps?: { fetch?: Fetch },
): Promise<void> {
  const doFetch = deps?.fetch ?? fetch;
  const r = await doFetch(`${trim(cfg.serverUrl)}/v1/members/${encodeURIComponent(memberId)}/envelope`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.teamToken}`, "content-type": "application/json" },
    body: JSON.stringify({ envelope }),
  });
  if (!r.ok) throw new Error(`enroll failed: HTTP ${r.status} ${await safeText(r)}`);
}

/** Fetch this member's sealed envelope, or null if not enrolled yet. */
export async function fetchEnvelope(
  cfg: TeamConfig,
  memberId: string,
  deps?: { fetch?: Fetch },
): Promise<string | null> {
  const doFetch = deps?.fetch ?? fetch;
  const r = await doFetch(`${trim(cfg.serverUrl)}/v1/members/${encodeURIComponent(memberId)}/envelope`, {
    headers: { authorization: `Bearer ${cfg.teamToken}` },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`fetch envelope failed: HTTP ${r.status} ${await safeText(r)}`);
  return ((await r.json()) as any).envelope ?? null;
}

// ---- team audit log ------------------------------------------------------

export interface TeamAuditRow {
  ts: string;
  actor: string | null;
  event: string;
  detail: string | null;
}

/** How a member proves authorship of an attributed request. `sign` returns a
 *  base64 Ed25519 signature over the canonical payload; the actual signing key
 *  never leaves the caller (keychain in production, in-memory in tests). */
export interface MemberAuth {
  memberId: string;
  sign: (canonicalPayload: string) => string;
}

/** Build the signature headers for an attributed request. Canonical payload
 *  matches the server: method \n path \n timestamp \n nonce \n sha256hex(body). */
function signedHeaders(auth: MemberAuth, method: string, path: string, body: string): Record<string, string> {
  const ts = new Date().toISOString();
  const nonce = randomBytes(12).toString("hex");
  const bodyHash = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
  const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
  return {
    "x-stm-member": auth.memberId,
    "x-stm-timestamp": ts,
    "x-stm-nonce": nonce,
    "x-stm-signature": auth.sign(canonical),
  };
}

/**
 * Push local audit rows newer than the config's cursor to the team log, SIGNED
 * by the member so the server can attribute them to a verified identity (the
 * server derives the actor from the signature and ignores anything we claim).
 * Only placeholder-form commands are sent (never a resolved key). Returns how
 * many were pushed and the new cursor (the caller persists the updated config).
 */
export async function pushLocalAudit(deps: {
  store: Store;
  cfg: TeamConfig;
  auth: MemberAuth;
  fetch?: Fetch;
}): Promise<{ pushed: number; cursor: number; cfg: TeamConfig }> {
  const doFetch = deps.fetch ?? fetch;
  const since = deps.cfg.auditCursor ?? 0;
  const local = deps.store.listAuditForSync(since, 1000);
  if (local.length === 0) return { pushed: 0, cursor: since, cfg: deps.cfg };
  const rows = local.map((r) => ({
    ts: r.ts,
    event: r.event,
    // placeholder-form command only; falls back to the tool:label address
    detail: r.command ?? `${r.tool ?? ""}:${r.label ?? ""}`,
  }));
  const body = JSON.stringify({ rows });
  const resp = await doFetch(`${trim(deps.cfg.serverUrl)}/v1/audit`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deps.cfg.teamToken}`,
      "content-type": "application/json",
      ...signedHeaders(deps.auth, "POST", "/v1/audit", body),
    },
    body,
  });
  if (!resp.ok) throw new Error(`audit push failed: HTTP ${resp.status} ${await safeText(resp)}`);
  const cursor = local[local.length - 1].id;
  const cfg = { ...deps.cfg, auditCursor: cursor };
  return { pushed: rows.length, cursor, cfg };
}

/** Fetch the team's combined audit log (most recent first). */
export async function fetchTeamAudit(
  cfg: TeamConfig,
  limit = 100,
  deps?: { fetch?: Fetch },
): Promise<TeamAuditRow[]> {
  const doFetch = deps?.fetch ?? fetch;
  const r = await doFetch(`${trim(cfg.serverUrl)}/v1/audit?limit=${limit}`, {
    headers: { authorization: `Bearer ${cfg.teamToken}` },
  });
  if (!r.ok) throw new Error(`fetch team audit failed: HTTP ${r.status} ${await safeText(r)}`);
  return ((await r.json()) as any).rows ?? [];
}

/** One brokered-call usage record as stored + returned by the team server. */
export interface TeamUsageRow {
  ts: string;
  actor: string | null;
  tool: string;
  label: string;
  method: string | null;
  path: string | null;
  status: number | null;
  bytes: number | null;
}

/**
 * Push local brokered-call usage records newer than the cursor to the team
 * usage log, SIGNED so the server attributes them to a verified member. Usage
 * records are metadata only (tool, label, method, upstream path, status, size)
 * — never a key, request body, or response body. Returns how many were pushed
 * and the new cursor (the caller persists the updated config).
 */
export async function pushLocalUsage(deps: {
  store: Store;
  cfg: TeamConfig;
  auth: MemberAuth;
  fetch?: Fetch;
}): Promise<{ pushed: number; cursor: number; cfg: TeamConfig }> {
  const doFetch = deps.fetch ?? fetch;
  const since = deps.cfg.usageCursor ?? 0;
  const local = deps.store.listUsageForSync(since, 1000);
  if (local.length === 0) return { pushed: 0, cursor: since, cfg: deps.cfg };
  const rows = local.map((r) => ({
    ts: r.ts,
    tool: r.tool,
    label: r.label,
    method: r.method ?? undefined,
    path: r.path ?? undefined,
    status: r.status ?? undefined,
    bytes: r.bytes ?? undefined,
  }));
  const body = JSON.stringify({ rows });
  const resp = await doFetch(`${trim(deps.cfg.serverUrl)}/v1/usage`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deps.cfg.teamToken}`,
      "content-type": "application/json",
      ...signedHeaders(deps.auth, "POST", "/v1/usage", body),
    },
    body,
  });
  if (!resp.ok) throw new Error(`usage push failed: HTTP ${resp.status} ${await safeText(resp)}`);
  const cursor = local[local.length - 1].id;
  const cfg = { ...deps.cfg, usageCursor: cursor };
  return { pushed: rows.length, cursor, cfg };
}

/** Fetch the team's combined usage log (most recent first). Optional filters
 *  narrow to one provider (`tool`) or one member (`member`). */
export async function fetchTeamUsage(
  cfg: TeamConfig,
  opts: { limit?: number; tool?: string; member?: string } = {},
  deps?: { fetch?: Fetch },
): Promise<TeamUsageRow[]> {
  const doFetch = deps?.fetch ?? fetch;
  const q = new URLSearchParams({ limit: String(opts.limit ?? 100) });
  if (opts.tool) q.set("tool", opts.tool);
  if (opts.member) q.set("member", opts.member);
  const r = await doFetch(`${trim(cfg.serverUrl)}/v1/usage?${q}`, {
    headers: { authorization: `Bearer ${cfg.teamToken}` },
  });
  if (!r.ok) throw new Error(`fetch team usage failed: HTTP ${r.status} ${await safeText(r)}`);
  return ((await r.json()) as any).rows ?? [];
}

function trim(u: string): string {
  return u.replace(/\/+$/, "");
}

async function safeText(r: Response): Promise<string> {
  try { return (await r.text()).slice(0, 200); } catch { return ""; }
}
