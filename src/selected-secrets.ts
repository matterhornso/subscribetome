// Versioned, dashboard-authorized local integration. Never resolve the whole vault.
// Consumer permissions belong to the calling host; this is NOT a scoped token.
import { CredentialRevisionError, type SelectedKeyMetadata } from "./store.ts";

export interface SelectedSecretStore {
  listKeys(): Array<{ tool: string; label: string; status: string; created_at: string }>;
  viewKey(tool: string, label: string): { status: string } | null;
  resolve(tool: string, label: string): string | null;
  listSelectedKeys?(): SelectedKeyMetadata[];
  putSelectedKey?(input: { tool: string; label: string; value: string; expectedRevision: string | null }): { key: SelectedKeyMetadata; oldValueCleanupPending: boolean };
}

export const SELECTED_SECRETS_VERSION = 1;
const MAX_BODY = 32_768;
const MAX_VALUE = 16_384;
const forbidden = /^(MATTERHORN_WORK_|OPENWORK_|OPENCODE_|STM_|LD_|DYLD_|NODE_|BUN_|PYTHON|RUBY|PERL|GIT_|npm_)/i;
const processNames = new Set(["PATH", "HOME", "SHELL", "ENV", "BASH_ENV", "ZDOTDIR", "IFS", "CDPATH", "COMSPEC", "PATHEXT", "SYSTEMROOT", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "__PROTO__", "CONSTRUCTOR", "PROTOTYPE"]);

export function safeSecretEnvName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)
    && !forbidden.test(value) && !processNames.has(value.toUpperCase());
}

function segment(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function response(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

async function readBody(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("invalid request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new Error("invalid request");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function selectedSecretsRoute(req: Request, dashboardToken: string, store: SelectedSecretStore, backend: () => string): Promise<Response> {
  const url = new URL(req.url);
  // No query credentials, browser origins or non-literal loopback authority.
  if (!/^127\.0\.0\.1:\d+$/.test(req.headers.get("host") ?? "") || req.headers.has("origin")) return response({ error: "forbidden" }, 403);
  if (!dashboardToken || req.headers.get("x-stm-token") !== dashboardToken || url.search) return response({ error: "unauthorized" }, 401);
  if (url.pathname === "/api/integrations/v1/capabilities" && req.method === "GET") {
    try {
      return response({ version: SELECTED_SECRETS_VERSION, selectedResolution: true, revisionedWrites: typeof store.putSelectedKey === "function", backend: backend() });
    } catch { return response({ error: "keystore_unavailable" }, 503); }
  }
  if (url.pathname === "/api/integrations/v1/keys" && req.method === "GET") {
    // Explicit projection: never return keystore references, billing or values.
    try {
      return response({ version: 1, keys: store.listSelectedKeys ? store.listSelectedKeys() : store.listKeys().map(({ tool, label, status, created_at }) => ({ tool, label, status, updatedAt: created_at })) });
    } catch { return response({ error: "inventory_unavailable" }, 503); }
  }
  if (url.pathname === "/api/integrations/v1/keys" && req.method === "POST") {
    if (!store.putSelectedKey) return response({ error: "unsupported_operation" }, 409);
    let input: unknown;
    try { input = await readBody(req); } catch { return response({ error: "invalid_credential_update" }, 400); }
    if (!record(input) || input.version !== 1 || !segment(input.tool) || !segment(input.label)
      || typeof input.value !== "string" || !input.value || input.value.includes("\0") || Buffer.byteLength(input.value) > MAX_VALUE
      || !(input.expectedRevision === null || (typeof input.expectedRevision === "string" && /^[a-f0-9]{64}$/.test(input.expectedRevision)))
      || Object.keys(input).some(k => !["version", "tool", "label", "value", "expectedRevision"].includes(k))) return response({ error: "invalid_credential_update" }, 400);
    try {
      const result = store.putSelectedKey({ tool: input.tool, label: input.label, value: input.value, expectedRevision: input.expectedRevision });
      return response({ version: 1, ...result }, input.expectedRevision === null ? 201 : 200);
    } catch (error) {
      return error instanceof CredentialRevisionError
        ? response({ error: "credential_revision_conflict" }, 412)
        : response({ error: "credential_update_failed" }, 503);
    }
  }
  if (url.pathname !== "/api/integrations/v1/resolve" || req.method !== "POST") return response({ error: "not_found" }, 404);
  let input: unknown;
  try { input = await readBody(req); } catch { return response({ error: "invalid_selection" }, 400); }
  if (!record(input) || input.version !== 1 || !Array.isArray(input.bindings) || input.bindings.length > 32 || Object.keys(input).some(k => !["version", "bindings"].includes(k))) return response({ error: "invalid_selection" }, 400);
  const bindings: Array<{ envName: string; tool: string; label: string }> = [];
  const names = new Set<string>();
  for (const entry of input.bindings) {
    if (!record(entry) || !safeSecretEnvName(entry.envName) || !segment(entry.tool) || !segment(entry.label) || names.has(entry.envName.toUpperCase()) || Object.keys(entry).some(k => !["envName", "tool", "label"].includes(k))) return response({ error: "invalid_selection" }, 400);
    names.add(entry.envName.toUpperCase());
    bindings.push({ envName: entry.envName, tool: entry.tool, label: entry.label });
  }
  try {
    // Validate the entire selection before reading even one value.
    for (const entry of bindings) if (store.viewKey(entry.tool, entry.label)?.status !== "active") return response({ error: "key_unavailable" }, 409);
    const values: Record<string, string> = {};
    for (const entry of bindings) {
      const value = store.resolve(entry.tool, entry.label);
      if (!value || value.includes("\0") || Buffer.byteLength(value) > MAX_VALUE) return response({ error: "key_unavailable" }, 409);
      values[entry.envName] = value;
    }
    return response({ version: 1, values });
  } catch { return response({ error: "keystore_unavailable" }, 503); }
}
