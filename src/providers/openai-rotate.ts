// OpenAI provider-side key rotation (TODOS.md "Provider-side key rotation").
//
// `stm rotate <tool> <label>` has always been a LOCAL swap: the user mints a
// key in the provider dashboard and pastes it on stdin. This module is the
// provider-side alternative: mint the new key via OpenAI's Admin API, and
// best-effort delete the old one, so "rotate" actually rotates at the source.
//
// Endpoints (OpenAI Admin API, Bearer <admin-key> — the same admin credential
// the spend provider uses, keychain label `admin-key`):
//   GET    /v1/organization/projects                       list projects
//   POST   /v1/organization/projects/{pid}/service_accounts
//            → { id, api_key: { value, id } }              the documented way
//                                                          to MINT a project
//                                                          key programmatically
//   GET    /v1/organization/projects/{pid}/api_keys        list (redacted) keys
//   DELETE /v1/organization/projects/{pid}/api_keys/{kid}  delete a key
//
// Old-key deletion is matched by the last 4 characters of the stored value
// against each listed key's `redacted_value` suffix. Zero or multiple matches
// mean we DON'T delete — never guess-delete a credential. The result reports
// exactly what happened so the CLI can tell the user to finish up manually.
//
// SECURITY INVARIANTS:
//   - The admin key and the new key value appear ONLY in request/response
//     handling — never in a thrown error message, never logged.
//   - All requests go to the provider's own origin (constants below).
//   - Pure + dependency-injected (`fetch`, `now`) — fully testable offline.
//   - Field-verification note: this is written against OpenAI's documented
//     Admin API contract and covered by offline tests with canned responses;
//     like the other provider surfaces it needs one real-hardware run to
//     confirm the live contract (see FIELD_VERIFICATION.md).

const OPENAI_BASE = "https://api.openai.com/v1/organization";

export interface RotateDeps {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Injectable clock for the service-account name suffix — tests pin it. */
  now?: () => Date;
}

export interface RotateOptions {
  /**
   * The current (old) key value, used only to match `redacted_value` for the
   * best-effort provider-side delete. Optional: without it we skip deletion.
   */
  oldValue?: string | null;
  /**
   * Admin-API project id (proj_...). Optional when the org has exactly one
   * project; required otherwise (the thrown error lists the candidates).
   */
  projectId?: string | null;
}

export interface MintResult {
  /** The freshly minted key value. Caller writes it to the keychain and MUST NOT print it. */
  newValue: string;
  projectId: string;
  serviceAccountId: string;
}

/** What happened to the old provider-side key during `retire`. */
export type RetireOutcome =
  | "deleted"
  | "not-found"
  | "ambiguous"
  | "skipped"
  | "delete-failed";

/**
 * One provider's rotation surface, keyed like the spend registry.
 *
 * Deliberately TWO phases, not one. The caller must land the minted value in
 * the keychain BEFORE retiring the old key, so a keychain write that fails
 * can never leave the placeholder pointing at a key that was already deleted
 * upstream. Worst case with this ordering is an orphaned old key (harmless,
 * and reported); the reverse ordering's worst case is a dead placeholder.
 */
export interface RotationProvider {
  id: string;
  /** Keychain label of the credential that authorizes rotation. */
  adminCredentialLabel: string;
  /** Shown when the admin credential is missing. */
  credentialHint: string;
  /** Phase 1: create a new key at the provider. Throws on any failure. */
  mint(adminKey: string, opts: RotateOptions, deps?: RotateDeps): Promise<MintResult>;
  /** Phase 2: best-effort delete of the old key. NEVER throws — reports instead. */
  retire(
    adminKey: string,
    opts: { projectId: string; oldValue?: string | null },
    deps?: RotateDeps,
  ): Promise<RetireOutcome>;
}

async function adminGet(f: typeof fetch, adminKey: string, path: string, signal?: AbortSignal): Promise<any> {
  let r: Response;
  try {
    r = await f(`${OPENAI_BASE}${path}`, {
      headers: { Authorization: `Bearer ${adminKey}`, Accept: "application/json" },
      signal,
    });
  } catch (e: any) {
    throw new Error(`network: ${e?.message ?? String(e)}`);
  }
  if (r.status === 401 || r.status === 403) {
    throw new Error(`auth failed (HTTP ${r.status}) — is this an admin key (sk-admin-...)?`);
  }
  if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
  try {
    return await r.json();
  } catch {
    throw new Error("provider returned non-JSON response");
  }
}

export const openaiRotationProvider: RotationProvider = {
  id: "openai",
  adminCredentialLabel: "admin-key",
  credentialHint:
    "Create an admin key at platform.openai.com/settings/organization/admin-keys " +
    "(it starts with sk-admin-... and is separate from your runtime API key), then " +
    "store it as openai:admin-key — the same credential spend sync uses.",

  async mint(adminKey, opts, deps): Promise<MintResult> {
    if (!adminKey) throw new Error("missing admin key");
    const f = deps?.fetch ?? fetch;
    const signal = deps?.signal;

    // 1. Pin down the project.
    let projectId = opts.projectId ?? null;
    if (!projectId) {
      const page = await adminGet(f, adminKey, "/projects?limit=100", signal);
      const projects: { id: string; name?: string }[] = Array.isArray(page?.data) ? page.data : [];
      if (projects.length === 0) {
        throw new Error("no projects visible to this admin key");
      }
      if (projects.length > 1) {
        const list = projects.map((p) => `  ${p.id}  ${p.name ?? ""}`.trimEnd()).join("\n");
        throw new Error(
          `this org has ${projects.length} projects — pass --project <id>:\n${list}`,
        );
      }
      projectId = projects[0].id;
    }

    // 2. Mint the new key via a service account (the documented programmatic
    //    path — plain project API keys cannot be created via the API).
    const ts = (deps?.now ?? (() => new Date()))().toISOString().slice(0, 10);
    let r: Response;
    try {
      r = await f(`${OPENAI_BASE}/projects/${projectId}/service_accounts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ name: `stm-rotate-${ts}` }),
        signal,
      });
    } catch (e: any) {
      throw new Error(`network: ${e?.message ?? String(e)}`);
    }
    if (r.status === 401 || r.status === 403) {
      throw new Error(`auth failed (HTTP ${r.status}) — is this an admin key (sk-admin-...)?`);
    }
    if (!r.ok) throw new Error(`create service account: HTTP ${r.status}`);
    let created: any;
    try {
      created = await r.json();
    } catch {
      throw new Error("provider returned non-JSON response");
    }
    const newValue = created?.api_key?.value;
    const serviceAccountId = created?.id;
    if (typeof newValue !== "string" || newValue.length === 0 || typeof serviceAccountId !== "string") {
      // Deliberately shape-only — never echo response content that could
      // carry key material into an error message.
      throw new Error("unexpected response shape from service-account create");
    }

    return { newValue, projectId, serviceAccountId };
  },

  /**
   * Phase 2 — best-effort retire. Runs only AFTER the caller has stored the
   * minted value, so every failure path here is non-destructive: the new key
   * already works, and the worst outcome is an orphaned old key we report.
   * Never throws.
   */
  async retire(adminKey, opts, deps): Promise<RetireOutcome> {
    const oldValue = opts.oldValue ?? null;
    if (!adminKey || !oldValue || oldValue.length < 4) return "skipped";
    const f = deps?.fetch ?? fetch;
    const signal = deps?.signal;
    const last4 = oldValue.slice(-4);
    try {
      const page = await adminGet(f, adminKey, `/projects/${opts.projectId}/api_keys?limit=100`, signal);
      const keys: { id: string; redacted_value?: string }[] = Array.isArray(page?.data) ? page.data : [];
      const matches = keys.filter(
        (k) => typeof k?.redacted_value === "string" && k.redacted_value.endsWith(last4),
      );
      if (matches.length === 0) return "not-found";
      // Never guess-delete a credential: >1 last-4 match is ambiguous.
      if (matches.length > 1) return "ambiguous";
      const del = await f(`${OPENAI_BASE}/projects/${opts.projectId}/api_keys/${matches[0].id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminKey}`, Accept: "application/json" },
        signal,
      });
      return del.ok ? "deleted" : "delete-failed";
    } catch {
      return "delete-failed";
    }
  },
};

/**
 * Rotation registry — same lookup shape as the spend PROVIDERS registry.
 * One entry today; adding a provider is one module + one entry + tests.
 */
export const ROTATION_PROVIDERS: Record<string, RotationProvider> = {
  [openaiRotationProvider.id]: openaiRotationProvider,
};

export function getRotationProvider(id: string): RotationProvider | null {
  return ROTATION_PROVIDERS[id] ?? null;
}
