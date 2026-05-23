// Spend-visibility provider interface (specs/spend-visibility.md §5).
//
// Each provider is a small module that knows how to read one number — the
// month-to-date USD spend for the calling user — from one external billing
// API. Providers are pure functions over a usage credential: zero
// filesystem access, zero database access, one outbound HTTP call.
//
// The orchestrator in `sync.ts` is the only place that resolves the usage
// credential from the keychain, calls the provider, and writes the result
// to the `spend` SQLite table. Providers themselves never see the store
// and never see any key that is not the one they need.

/**
 * Provider implementations export an object of this shape. The keychain
 * lookup is done by the orchestrator; providers receive the resolved
 * key value (or null if the user hasn't configured a usage credential).
 */
export interface SpendProvider {
  /**
   * Stable identifier — matches the corresponding catalog `id` field.
   * Used as the join key against the inventory.
   */
  id: string;

  /**
   * The credential label the orchestrator looks up in the keychain to
   * obtain a usage key. Always a separate label from the runtime key
   * (e.g. `admin-key` for OpenAI), so the user has to opt in
   * explicitly — see specs/spend-visibility.md §3.
   */
  usageCredentialLabel: string;

  /**
   * One-line human-readable description of what the provider's usage
   * credential needs to look like. Shown by the dashboard's "Enable
   * sync" toggle so the user knows what kind of key to generate.
   */
  credentialHint: string;

  /**
   * Fetch the current month-to-date USD spend.
   *
   * Implementations must:
   * - Make exactly one outbound HTTP call.
   * - Honor `deps.fetch` when supplied (test injection seam).
   * - Honor `deps.signal` when supplied (caller-driven cancellation).
   * - Return a non-negative finite number.
   * - Throw with a short human-readable message on any failure —
   *   network, auth, parse, rate-limit. The orchestrator records the
   *   message via `Store.markSpendError` and the dashboard surfaces
   *   it under the affected row.
   */
  current(
    usageKey: string,
    deps?: { fetch?: typeof fetch; signal?: AbortSignal },
  ): Promise<{ monthlyToDateUSD: number; asOf: string }>;
}

/**
 * Compute the [start, end] Unix timestamps (seconds since epoch) for the
 * current calendar month UTC. Provider implementations use these to
 * narrow the API query window to "month to date".
 */
export function currentMonthWindow(now: Date = new Date()): {
  startUnix: number;
  endUnix: number;
} {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  return {
    startUnix: Math.floor(start.getTime() / 1000),
    endUnix: Math.floor(now.getTime() / 1000),
  };
}
