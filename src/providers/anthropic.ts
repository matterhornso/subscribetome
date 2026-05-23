// Anthropic spend provider (specs/spend-visibility.md Phase 3).
//
// Uses the Anthropic Admin API's cost-report endpoint. As with OpenAI,
// the endpoint returns time-bucketed cost data; we sum the month-to-date
// buckets and return one number.
//
// Endpoint:   GET https://api.anthropic.com/v1/organizations/cost_report
// Auth:       x-api-key: <admin-api-key>   (admin scope, NOT the runtime
//             api-key — admin keys are created at console.anthropic.com
//             under Settings → Admin Keys)
// Versioning: anthropic-version: 2023-06-01
// Query:      starting_at=<RFC3339>&ending_at=<RFC3339>
// Response:   { data: [{ amount: { value, currency }, ... }], ... }
//
// The endpoint shape is the documented Anthropic Admin API as of 2026;
// if Anthropic changes the surface, this module is one file to update.
// On any non-2xx the orchestrator records the error verbatim — the
// dashboard then shows the affected row with a "last sync failed" badge
// without zeroing out the previous good value.
import type { SpendProvider } from "./types.ts";
import { currentMonthWindow } from "./types.ts";

const ANTHROPIC_COSTS_URL =
  "https://api.anthropic.com/v1/organizations/cost_report";

export const anthropicProvider: SpendProvider = {
  id: "anthropic",
  usageCredentialLabel: "admin-key",
  credentialHint:
    "Create an admin key at console.anthropic.com under Settings → Admin Keys " +
    "(it is separate from your runtime API key and grants billing-scoped access).",

  async current(
    usageKey: string,
    deps?: { fetch?: typeof fetch; signal?: AbortSignal },
  ): Promise<{ monthlyToDateUSD: number; asOf: string }> {
    if (!usageKey) throw new Error("missing admin key");
    const f = deps?.fetch ?? fetch;
    const { startUnix, endUnix } = currentMonthWindow();
    // Anthropic's API takes RFC3339, not Unix seconds.
    const startISO = new Date(startUnix * 1000).toISOString();
    const endISO = new Date(endUnix * 1000).toISOString();
    const url =
      `${ANTHROPIC_COSTS_URL}` +
      `?starting_at=${encodeURIComponent(startISO)}` +
      `&ending_at=${encodeURIComponent(endISO)}`;

    let r: Response;
    try {
      r = await f(url, {
        headers: {
          "x-api-key": usageKey,
          "anthropic-version": "2023-06-01",
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

    // Tolerant parse: sum every `amount.value` we can find in the
    // response. Anthropic's cost report returns daily buckets with
    // per-bucket amount objects; the same loop handles a single-row
    // summary if the API ever flattens it.
    if (!body || !Array.isArray(body.data)) {
      throw new Error("unexpected response shape (no .data array)");
    }
    let total = 0;
    for (const bucket of body.data) {
      // Two possible shapes — per-bucket `amount` or per-bucket `results`
      // mirroring OpenAI. Handle both defensively.
      const direct = bucket?.amount?.value;
      if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) {
        total += direct;
        continue;
      }
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
