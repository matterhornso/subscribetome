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
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { encryptVault, decryptVault } from "../keystores/encrypted-file.ts";
import { keychainGet, keychainSet, keychainDelete } from "../keychain.ts";
import { DATA_DIR, ensureDataDir } from "../paths.ts";
import type { Store } from "../store.ts";

const TEAM_CONFIG_FILE = process.env.STM_TEAM_CONFIG || join(DATA_DIR, "teams.json");
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
}

export interface TeamVaultPayload {
  stmTeamVault: typeof TEAM_VAULT_VERSION;
  updatedAt: string;
  keys: { tool: string; label: string; value: string }[];
}

// ---- local config + passphrase ------------------------------------------

export function readTeamConfig(): TeamConfig | null {
  try {
    const cfg = JSON.parse(readFileSync(TEAM_CONFIG_FILE, "utf8")) as TeamConfig;
    if (cfg && typeof cfg.serverUrl === "string" && typeof cfg.teamToken === "string") return cfg;
    return null;
  } catch {
    return null;
  }
}

export function writeTeamConfig(cfg: TeamConfig): void {
  ensureDataDir();
  // Unlink then write with mode 0600 so the file is 0600 from creation (umask
  // only clears bits). The dir is 0700, so there is no readable window; the file
  // holds only the shareable team bearer token, never the team key.
  try { unlinkSync(TEAM_CONFIG_FILE); } catch { /* absent */ }
  writeFileSync(TEAM_CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { chmodSync(TEAM_CONFIG_FILE, 0o600); } catch { /* non-POSIX */ }
}

export function teamConfigured(): boolean {
  return existsSync(TEAM_CONFIG_FILE) && readTeamConfig() != null;
}

/** Store the team passphrase in the OS keychain (never on disk in plaintext). */
export function setTeamPassphrase(passphrase: string): void {
  keychainSet(TEAM_PASSPHRASE_REF, passphrase);
}

export function getTeamPassphrase(): string | null {
  return keychainGet(TEAM_PASSPHRASE_REF);
}

/** A fresh high-entropy team key, used as the vault-encryption passphrase and
 *  distributed to members by sealing it to their public keys. */
export function generateTeamKey(): string {
  return randomBytes(32).toString("base64");
}

export function clearTeam(): void {
  try { unlinkSync(TEAM_CONFIG_FILE); } catch { /* absent */ }
  try { keychainDelete(TEAM_PASSPHRASE_REF); } catch { /* absent */ }
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
  fetch?: Fetch;
}): Promise<{ version: number; keyCount: number }> {
  const doFetch = deps.fetch ?? fetch;
  const keys: TeamVaultPayload["keys"] = [];
  for (const k of deps.store.listKeys()) {
    if (k.status !== "active") continue;
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
  return { version, keyCount: keys.length };
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
      added++;
    } catch {
      skipped++; // already present (UNIQUE) or invalid — leave the local copy alone
    }
  }
  return { version, added, skipped };
}

// ---- public-key enrollment -----------------------------------------------

/** Register (or refresh) a member's public key with the team (pending until an
 *  existing member seals the team key to it). */
export async function registerMember(
  cfg: TeamConfig,
  memberId: string,
  pubkey: string,
  deps?: { fetch?: Fetch },
): Promise<void> {
  const doFetch = deps?.fetch ?? fetch;
  const r = await doFetch(`${trim(cfg.serverUrl)}/v1/members`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.teamToken}`, "content-type": "application/json" },
    body: JSON.stringify({ memberId, pubkey }),
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
): Promise<{ memberId: string; pubkey: string; enrolled: boolean } | null> {
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

/**
 * Push local audit rows newer than the config's cursor to the team log, then
 * advance the cursor. Only placeholder-form commands are sent (never a resolved
 * key), so nothing secret leaves the machine. Returns how many were pushed and
 * the new cursor (the caller persists the updated config).
 */
export async function pushLocalAudit(deps: {
  store: Store;
  cfg: TeamConfig;
  actor: string;
  fetch?: Fetch;
}): Promise<{ pushed: number; cursor: number; cfg: TeamConfig }> {
  const doFetch = deps.fetch ?? fetch;
  const since = deps.cfg.auditCursor ?? 0;
  const local = deps.store.listAuditForSync(since, 1000);
  if (local.length === 0) return { pushed: 0, cursor: since, cfg: deps.cfg };
  const rows: TeamAuditRow[] = local.map((r) => ({
    ts: r.ts,
    actor: deps.actor,
    event: r.event,
    // placeholder-form command only; falls back to the tool:label address
    detail: r.command ?? `${r.tool ?? ""}:${r.label ?? ""}`,
  }));
  const resp = await doFetch(`${trim(deps.cfg.serverUrl)}/v1/audit`, {
    method: "POST",
    headers: { authorization: `Bearer ${deps.cfg.teamToken}`, "content-type": "application/json" },
    body: JSON.stringify({ rows }),
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

function trim(u: string): string {
  return u.replace(/\/+$/, "");
}

async function safeText(r: Response): Promise<string> {
  try { return (await r.text()).slice(0, 200); } catch { return ""; }
}
