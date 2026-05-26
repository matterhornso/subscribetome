// Sync orchestrator (specs/spend-visibility.md §5).
//
// Reads a provider's usage credential from the keychain, calls its
// `current()` once, and writes the result to the SQLite `spend` table.
// This is the ONLY place outbound HTTP happens for spend; the providers
// themselves are pure functions over a credential.
//
// Posture rule from §2 of the spec — visible on every surface that
// triggers sync (CLI help, dashboard tooltip, README, landing page):
//   "stm makes outbound network calls only when you click sync, only
//    to the providers you've configured. No background activity, no
//    telemetry, no phone-home. Ever."
//
// Concretely that means: this module does nothing on its own. It is
// only invoked by the CLI `stm sync` or the daemon's
// `POST /api/spend/sync` endpoint, both of which are user-initiated.
import { Store } from "./store.ts";
import { PROVIDERS, getProvider, listProviderIds, type SpendProvider } from "./providers/index.ts";

export interface SyncResult {
  tool: string;
  ok: boolean;
  /** Month-to-date USD on success. */
  usd?: number;
  /** ISO timestamp when the sync attempt completed. */
  at: string;
  /** Human-readable failure reason on `ok: false`. */
  error?: string;
  /** True when the provider's usage credential wasn't found in the keychain. */
  missingCredential?: boolean;
}

/**
 * Sync one provider. Resolves the usage credential, calls
 * `provider.current()`, writes either a success row via `setSpend` or
 * an error row via `markSpendError`. Never throws — failures are
 * captured in the returned `SyncResult`.
 *
 * Per the spec's "Never silently zero out a previous value on error"
 * rule (§5), the error branch preserves the prior `fetched_usd`.
 */
export async function syncOne(
  provider: SpendProvider,
  opts?: { store?: Store; fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number },
): Promise<SyncResult> {
  const ownsStore = !opts?.store;
  const store = opts?.store ?? new Store();
  const at = new Date().toISOString();
  try {
    // Ensure the tool row exists — it might not, if the user configured
    // the usage credential but hasn't added a runtime key yet. upsertTool
    // is idempotent.
    const tool = store.upsertTool({ name: provider.id });

    const usageKey = store.resolve(provider.id, provider.usageCredentialLabel);
    if (!usageKey) {
      return {
        tool: provider.id,
        ok: false,
        at,
        error: `no ${provider.id}:${provider.usageCredentialLabel} key in keychain — ` +
          `add one in the dashboard to enable sync`,
        missingCredential: true,
      };
    }

    // Apply a default 15s timeout so a hung provider doesn't wedge the
    // dashboard's Sync button. The caller's signal (if any) is honored
    // alongside ours via the standard `AbortSignal.any` pattern.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 15_000);
    const signal = opts?.signal
      ? anySignal([opts.signal, ctrl.signal])
      : ctrl.signal;

    let res: Awaited<ReturnType<SpendProvider["current"]>>;
    try {
      res = await provider.current(usageKey, { fetch: opts?.fetch, signal });
    } finally {
      clearTimeout(t);
    }

    if (
      typeof res?.monthlyToDateUSD !== "number" ||
      !Number.isFinite(res.monthlyToDateUSD) ||
      res.monthlyToDateUSD < 0
    ) {
      throw new Error("provider returned non-numeric spend");
    }

    store.setSpend({
      toolId: tool.id,
      usd: res.monthlyToDateUSD,
      asOf: res.asOf || at,
    });
    return { tool: provider.id, ok: true, usd: res.monthlyToDateUSD, at: res.asOf || at };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    try {
      const tool = store.upsertTool({ name: provider.id });
      store.markSpendError(tool.id, msg);
    } catch {
      /* best-effort — if the store write fails too, just return the result */
    }
    return { tool: provider.id, ok: false, at, error: msg };
  } finally {
    if (ownsStore) store.close();
  }
}

/**
 * Sync every registered provider. Each provider is independent — one
 * failing doesn't block the others. Returns one `SyncResult` per
 * provider, regardless of outcome.
 *
 * Concurrency: providers are run in parallel. Bun's fetch is fine with
 * a handful of concurrent requests; the current registry is small.
 */
export async function syncAll(
  opts?: { store?: Store; fetch?: typeof fetch; signal?: AbortSignal },
): Promise<SyncResult[]> {
  const ownsStore = !opts?.store;
  const store = opts?.store ?? new Store();
  try {
    const ids = listProviderIds();
    return await Promise.all(
      ids.map((id) => syncOne(PROVIDERS[id], { store, fetch: opts?.fetch, signal: opts?.signal })),
    );
  } finally {
    if (ownsStore) store.close();
  }
}

/** Sync one provider by id. Returns null if the id isn't registered. */
export async function syncProvider(
  id: string,
  opts?: { store?: Store; fetch?: typeof fetch; signal?: AbortSignal },
): Promise<SyncResult | null> {
  const p = getProvider(id);
  if (!p) return null;
  return syncOne(p, opts);
}

/**
 * Map a raw sync error message to an actionable user-facing hint.
 *
 * Early customers will hit a variety of network/auth conditions
 * and the bare error string (e.g. `network: ECONNREFUSED 8.8.8.8`)
 * is not actionable. This classifier maps each known shape to:
 *   - a short summary that fits the result-row column,
 *   - a one-line hint describing the next step.
 *
 * Unknown errors fall through with `hint: null` (the row stays
 * compact). The classifier is forgiving — when in doubt it
 * prefers no hint over a wrong one.
 */
export interface SyncErrorHint {
  /** Original raw error message. */
  raw: string;
  /** One-line summary, fits the result-row column. */
  summary: string;
  /** Next-step hint, or null when we don't recognise the error. */
  hint: string | null;
}

export function humanizeSyncError(raw: string): SyncErrorHint {
  // Auth failure (provider-side or admin-key revoked).
  if (/HTTP 40[13]|auth failed/i.test(raw)) {
    return {
      raw,
      summary: "authentication failed",
      hint:
        "your admin/usage key may be revoked or wrong. Rotate it in the " +
        "provider's dashboard, then update via the stm dashboard.",
    };
  }
  // Rate limit.
  if (/rate.?limit|HTTP 429/i.test(raw)) {
    return {
      raw,
      summary: "rate limited",
      hint:
        "wait a minute, then retry. Most provider admin APIs allow only a " +
        "handful of requests per minute.",
    };
  }
  // Provider 5xx — their problem, not yours.
  if (/HTTP 5\d\d/i.test(raw)) {
    return {
      raw,
      summary: "provider API error",
      hint:
        "the provider's API returned a 5xx response. Check their status " +
        "page and retry later.",
    };
  }
  // DNS — common on corp networks, VPNs, captive portals.
  if (/ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(raw)) {
    return {
      raw,
      summary: "DNS lookup failed",
      hint:
        "are you online? Check your VPN / firewall and confirm the " +
        "provider's hostname resolves from this machine.",
    };
  }
  // Connection refused — different from DNS; reachable host that won't talk.
  if (/ECONNREFUSED/i.test(raw)) {
    return {
      raw,
      summary: "connection refused",
      hint:
        "check VPN, firewall, or a corporate proxy that may be rewriting " +
        "outbound HTTPS.",
    };
  }
  // Timeout — our 15s ceiling or the OS-level one.
  if (/ETIMEDOUT|timed?\s*out|AbortError|operation was aborted/i.test(raw)) {
    return {
      raw,
      summary: "request timed out",
      hint:
        "the provider didn't respond within 15s. Retry, or check your " +
        "network if this keeps happening.",
    };
  }
  // TLS — usually proxy interception or stale system trust store.
  if (/certificate|TLS|self.signed|UNABLE_TO_VERIFY|SSL/i.test(raw)) {
    return {
      raw,
      summary: "TLS / certificate error",
      hint:
        "your system trust store may be out of date, or an HTTPS-intercepting " +
        "proxy is in the path.",
    };
  }
  // Generic network class — keep the original phrasing.
  if (/^network:|fetch failed|ECONNRESET|socket hang up/i.test(raw)) {
    return {
      raw,
      summary: raw.startsWith("network: ") ? raw : `network error: ${raw}`,
      hint:
        "transient network error. Retry `stm sync`; if it persists, check " +
        "your connection.",
    };
  }
  // Provider response shape changed — points at stm, not the user.
  if (/non-JSON|non-numeric|unexpected response shape/i.test(raw)) {
    return {
      raw,
      summary: "unexpected provider response",
      hint:
        "the provider may have changed its API. Check stm's GitHub issues, " +
        "or open one with this exact error.",
    };
  }
  // Unknown — pass through, no hint.
  return { raw, summary: raw, hint: null };
}

/**
 * Polyfill `AbortSignal.any` for older Bun versions. Bun >=1.1 has it
 * native; we keep this so the module compiles cleanly without depending
 * on the exact runtime version.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any(signals);
  }
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}
