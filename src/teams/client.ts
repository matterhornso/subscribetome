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
  // Create 0600 atomically — the file holds the team bearer token.
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

function trim(u: string): string {
  return u.replace(/\/+$/, "");
}

async function safeText(r: Response): Promise<string> {
  try { return (await r.text()).slice(0, 200); } catch { return ""; }
}
