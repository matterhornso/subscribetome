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
 * What a rotation WOULD do, without doing any of it. Every call it makes is
 * read-only (list projects, list keys), so this is the safe way to confirm
 * the provider's API contract — auth, project resolution, and whether the old
 * key can be matched — before running a real, destructive rotation.
 */
export interface PreflightResult {
  projectId: string;
  /** How many projects the admin key can see (1 = auto-selectable). */
  projectCount: number;
  /** How many keys the project lists. */
  keyCount: number;
  /** What `retire` would do with the old key. */
  oldKeyMatch: "would-delete" | "not-found" | "ambiguous" | "skipped";
  /** The key id that would be deleted, when the match is unambiguous. */
  matchedKeyId?: string;
}

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
  /**
   * Read-only rehearsal: resolve the project and check the old-key match
   * without minting or deleting anything. Throws on the same auth/project
   * problems a real run would hit, so it is a true contract check.
   */
  preflight(adminKey: string, opts: RotateOptions, deps?: RotateDeps): Promise<PreflightResult>;
  /** Phase 1: create a new key at the provider. Throws on any failure. */
  mint(adminKey: string, opts: RotateOptions, deps?: RotateDeps): Promise<MintResult>;
  /** Phase 2: best-effort delete of the old key. NEVER throws — reports instead. */
  retire(
    adminKey: string,
    opts: { projectId: string; oldValue?: string | null },
    deps?: RotateDeps,
  ): Promise<RetireOutcome>;
}

/**
 * Make a provider-supplied string safe to put in an error message, an audit
 * row, or the terminal.
 *
 * Project names are attacker-influenceable: anyone who can name a project in
 * the org (or who has compromised it) controls this text, and it ends up in
 * `audit_log.reason`, which `stm audit` prints back into the agent's context.
 * Strip control characters (ANSI escapes, newlines that could forge a second
 * log line) and clamp the length.
 */
function safeProviderText(s: unknown, max = 60): string {
  if (typeof s !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return stripped.length > max ? stripped.slice(0, max) + "…" : stripped;
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

/**
 * Resolve which project to operate on. Auto-selects when the admin key sees
 * exactly one; otherwise refuses and lists the candidates rather than guessing
 * which project's keys to touch. Shared by preflight and mint so the two can
 * never disagree about the target.
 */
async function resolveProject(
  f: typeof fetch,
  adminKey: string,
  explicit: string | null,
  signal?: AbortSignal,
): Promise<{ projectId: string; projectCount: number }> {
  if (explicit) return { projectId: explicit, projectCount: 1 };
  const page = await adminGet(f, adminKey, "/projects?limit=100", signal);
  const projects: { id: string; name?: string }[] = Array.isArray(page?.data) ? page.data : [];
  if (projects.length === 0) throw new Error("no projects visible to this admin key");
  if (projects.length > 1) {
    // Both id and name are provider-controlled — sanitize before they reach an
    // error message that may be persisted in the audit log.
    const list = projects
      .map((p) => `  ${safeProviderText(p.id, 64)}  ${safeProviderText(p.name)}`.trimEnd())
      .join("\n");
    throw new Error(`this org has ${projects.length} projects — pass --project <id>:\n${list}`);
  }
  const id = safeProviderText(projects[0]?.id, 64);
  if (!id) throw new Error("provider returned a project with no usable id");
  return { projectId: id, projectCount: projects.length };
}

/**
 * Match stored key value against the provider's redacted listing by last-4.
 * Returns every match; callers refuse to act on anything but exactly one.
 */
function matchByLast4(
  keys: { id: string; redacted_value?: string }[],
  oldValue: string,
): { id: string; redacted_value?: string }[] {
  const last4 = oldValue.slice(-4);
  return keys.filter(
    (k) => typeof k?.redacted_value === "string" && k.redacted_value.endsWith(last4),
  );
}

export const openaiRotationProvider: RotationProvider = {
  id: "openai",
  adminCredentialLabel: "admin-key",
  credentialHint:
    "Create an admin key at platform.openai.com/settings/organization/admin-keys " +
    "(it starts with sk-admin-... and is separate from your runtime API key), then " +
    "store it as openai:admin-key — the same credential spend sync uses.",

  async preflight(adminKey, opts, deps): Promise<PreflightResult> {
    if (!adminKey) throw new Error("missing admin key");
    const f = deps?.fetch ?? fetch;
    const signal = deps?.signal;
    const resolved = await resolveProject(f, adminKey, opts.projectId ?? null, signal);

    const oldValue = opts.oldValue ?? null;
    if (!oldValue || oldValue.length < 4) {
      return {
        projectId: resolved.projectId,
        projectCount: resolved.projectCount,
        keyCount: 0,
        oldKeyMatch: "skipped",
      };
    }
    const page = await adminGet(f, adminKey, `/projects/${encodeURIComponent(resolved.projectId)}/api_keys?limit=100`, signal);
    const keys: { id: string; redacted_value?: string }[] = Array.isArray(page?.data) ? page.data : [];
    const matches = matchByLast4(keys, oldValue);
    return {
      projectId: resolved.projectId,
      projectCount: resolved.projectCount,
      keyCount: keys.length,
      oldKeyMatch:
        matches.length === 0 ? "not-found" : matches.length > 1 ? "ambiguous" : "would-delete",
      matchedKeyId: matches.length === 1 ? safeProviderText(matches[0].id, 64) : undefined,
    };
  },

  async mint(adminKey, opts, deps): Promise<MintResult> {
    if (!adminKey) throw new Error("missing admin key");
    const f = deps?.fetch ?? fetch;
    const signal = deps?.signal;

    // 1. Pin down the project.
    const projectId = (await resolveProject(f, adminKey, opts.projectId ?? null, signal)).projectId;

    // 2. Mint the new key via a service account (the documented programmatic
    //    path — plain project API keys cannot be created via the API).
    const ts = (deps?.now ?? (() => new Date()))().toISOString().slice(0, 10);
    let r: Response;
    try {
      r = await f(`${OPENAI_BASE}/projects/${encodeURIComponent(projectId)}/service_accounts`, {
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

    return { newValue, projectId, serviceAccountId: safeProviderText(serviceAccountId, 64) };
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
    try {
      const page = await adminGet(f, adminKey, `/projects/${encodeURIComponent(opts.projectId)}/api_keys?limit=100`, signal);
      const keys: { id: string; redacted_value?: string }[] = Array.isArray(page?.data) ? page.data : [];
      const matches = matchByLast4(keys, oldValue);
      if (matches.length === 0) return "not-found";
      // Never guess-delete a credential: >1 last-4 match is ambiguous.
      if (matches.length > 1) return "ambiguous";
      const del = await f(
        `${OPENAI_BASE}/projects/${encodeURIComponent(opts.projectId)}` +
          `/api_keys/${encodeURIComponent(matches[0].id)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${adminKey}`, Accept: "application/json" },
          signal,
        },
      );
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
