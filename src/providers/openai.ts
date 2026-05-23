// OpenAI spend provider (specs/spend-visibility.md Phase 2).
//
// Uses the OpenAI Admin API's `/organization/costs` endpoint. The endpoint
// returns daily cost buckets; we sum the month-to-date buckets and return
// one number.
//
// Endpoint:   GET https://api.openai.com/v1/organization/costs
// Auth:       Bearer <admin-key>           (admin scope, not the runtime key)
// Query:      start_time=<unix>&end_time=<unix>&bucket_width=1d
// Response:   { data: [{ start_time, end_time, results: [{ amount: { value, currency }}] }] }
//
// The orchestrator passes a resolved admin key (the keychain entry with
// label `admin-key` against tool `openai`). Errors are thrown with a
// short message; the orchestrator records them via Store.markSpendError.
import type { SpendProvider } from "./types.ts";
import { currentMonthWindow } from "./types.ts";

const OPENAI_COSTS_URL = "https://api.openai.com/v1/organization/costs";

export const openaiProvider: SpendProvider = {
  id: "openai",
  usageCredentialLabel: "admin-key",
  credentialHint:
    "Create an admin key at platform.openai.com/settings/organization/admin-keys " +
    "(it starts with sk-admin-... and is separate from your runtime API key).",

  async current(
    usageKey: string,
    deps?: { fetch?: typeof fetch; signal?: AbortSignal },
  ): Promise<{ monthlyToDateUSD: number; asOf: string }> {
    if (!usageKey) throw new Error("missing admin key");
    const f = deps?.fetch ?? fetch;
    const { startUnix, endUnix } = currentMonthWindow();
    const url =
      `${OPENAI_COSTS_URL}?start_time=${startUnix}` +
      `&end_time=${endUnix}&bucket_width=1d&limit=31`;

    let r: Response;
    try {
      r = await f(url, {
        headers: {
          Authorization: `Bearer ${usageKey}`,
          Accept: "application/json",
        },
        signal: deps?.signal,
      });
    } catch (e: any) {
      throw new Error(`network: ${e?.message ?? String(e)}`);
    }
    if (r.status === 401 || r.status === 403) {
      throw new Error(`auth failed (HTTP ${r.status}) — is this an admin key?`);
    }
    if (r.status === 429) {
      throw new Error("rate limited (HTTP 429) — try again later");
    }
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`);
    }
    let body: any;
    try {
      body = await r.json();
    } catch {
      throw new Error("provider returned non-JSON response");
    }

    // The OpenAI costs endpoint returns daily buckets:
    //   { object: "page", data: [{ object: "bucket", start_time, end_time,
    //                              results: [{ amount: { value, currency } }] }] }
    // We sum every result's `amount.value` (USD) across every bucket.
    // Defensive parse: tolerate missing/non-array results without
    // exploding — return 0 in that case rather than crashing the sync.
    if (!body || !Array.isArray(body.data)) {
      throw new Error("unexpected response shape (no .data array)");
    }
    let total = 0;
    for (const bucket of body.data) {
      const results = Array.isArray(bucket?.results) ? bucket.results : [];
      for (const row of results) {
        const v = row?.amount?.value;
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
          total += v;
        }
      }
    }
    return { monthlyToDateUSD: total, asOf: new Date().toISOString() };
  },
};
