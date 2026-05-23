# Spec — Spend visibility (the second product)

**Status:** Phases 1-3 shipped (v0.3.0) · Phase 4 (Stripe) deferred · **Target:** v0.3 · **Last updated:** 2026-05-23

stm's first product hides API keys. This spec covers the second: showing the
user what those keys are actually doing — real spend, pulled on demand from
each provider's billing/usage API.

## 1. Goal

Replace the dashboard's manually-typed monthly cost with **real numbers
fetched from provider APIs, on demand, never automatic**, so the header total
reflects what's actually being spent.

**Why this is the right second product.** A leaked or stolen key racking up
$4,000 in two hours is exactly the kind of thing stm should surface. The
cheapest way to detect it is to ask the provider. It also turns the
half-useful manual ledger into a real one without redesigning the UI.

### Non-goals (v1)

- Background / automatic polling. The user clicks to sync; nothing else.
- Per-call metering by intercepting agent commands.
- Cost forecasting, alerts, or optimization recommendations.
- Multi-currency.

## 2. The honest tension — and the rule that follows

stm today makes **zero outbound network calls.** That is a load-bearing line
in the trust pitch. Spend visibility breaks it the moment it ships.

The product rule that resolves this:

> stm makes outbound network calls **only when you click sync, only to the
> providers you've configured.** No background activity, no telemetry, no
> phone-home. Ever.

Concretely:
- Sync is **off by default**, **opted in per provider**, **user-initiated**.
- The dashboard surfaces *when* a sync last ran for each provider —
  staleness is never hidden.
- The README and landing page state this rule verbatim, next to the feature.

If we cannot guarantee the rule above, we don't ship the feature.

## 3. The credential model

Most providers' usage / billing APIs require a **different credential** than
the runtime API key — usually an admin-scoped or organization-scoped key:

| Provider | Runtime key (today) | Usage credential (new) |
|---|---|---|
| OpenAI | `api-key` (`sk-...`) | Admin key (`sk-admin-...`), org-scoped |
| Anthropic | `api-key` (`sk-ant-...`) | Admin API key, separate |
| Stripe | `secret-key` (`sk_...`) | Same key, restricted-key with reporting scope preferred |

Implications:
- A new optional credential label per provider that supports sync (e.g.
  `admin-key` for OpenAI). It's added the same out-of-band way as any other
  secret — entered in the dashboard, stored in the keychain.
- The usage credential is **more sensitive** than the runtime key (admin
  scope). The dashboard says so when the user enables sync for a provider.

## 4. UX

### Dashboard

- A **"Sync spend"** button near the monthly-spend badge in the header.
  Disabled until at least one provider has sync configured.
- The catalog gains an optional "Enable sync" toggle on provider entries that
  support it. Toggling on prompts for the usage credential.
- The header monthly-spend badge has three states:
  - `$240.18` — every tracked tool has a fetched number
  - `$240.18 ✦ partial` — some fetched, some self-reported
  - `$0.00 ✦ self-reported` — manual ledger only (today's state)
  - Tooltip: which providers are sync-enabled and when each last ran.
- Subscriptions table: a small "fetched" / "self-reported" tag in the
  Monthly column.

### CLI

- `stm sync` — refresh every sync-enabled provider.
- `stm sync openai` — one provider.
- `stm status` shows last-sync timestamp per provider.

## 5. Provider integration shape

Each integration is a small module under `src/providers/<id>.ts`:

```ts
interface SpendProvider {
  id: string;                       // matches catalog id, e.g. "openai"
  usageCredentialLabel: string;     // e.g. "admin-key"
  current(usageKey: string): Promise<{
    monthlyToDateUSD: number;
    asOf: string;                   // ISO timestamp the provider returned
  }>;
}
```

A resolver finds the provider by tool id, reads the usage credential from
the KeyStore, calls the provider's API once, and returns the number. Failure
modes are surfaced honestly — timeout, auth, rate-limit. **Never silently
zero out a previous value on error.**

A `supports-usage: true` flag on the catalog entry tells the dashboard which
services to show the "Enable sync" toggle for.

## 6. Storage

Add a `spend` table to the SQLite store:

```sql
CREATE TABLE spend (
  tool_id     INTEGER PRIMARY KEY REFERENCES tools(id) ON DELETE CASCADE,
  fetched_usd REAL,
  fetched_at  TEXT,
  source      TEXT CHECK(source IN ('fetched','manual'))
);
```

`monthlySpend()` sums `spend.fetched_usd` when present, falling back to the
existing `tools.monthly_cost`. The manual ledger keeps working unchanged;
sync supplements it.

No expiry / TTL. Fetched values stay until the next manual sync. *Showing*
"last synced 3 days ago" makes staleness explicit instead of hiding it
behind a stale number.

## 7. Phasing

- **Phase 1 — Foundation.** `spend` table, `SpendProvider` interface, dashboard
  "Sync spend" button, `stm sync` CLI. Button disabled until a provider lands.
  **Shipped v0.3.0.**
- **Phase 2 — OpenAI.** First provider. Biggest user base, admin API
  documented. Establishes the "add a separate admin credential" UX.
  **Shipped v0.3.0.**
- **Phase 3 — Anthropic.** Same pattern. **Shipped v0.3.0.**
- **Phase 4 — Stripe.** Different category (your *own* Stripe account spend,
  not API spend) — adapt the UI to make that clear, or ship as a separate
  "Stripe income" panel and keep this feature focused on API spend.
  **Deferred** — best modeled as a separate "Stripe income" panel; out of
  scope for the API-spend feature.
- **Phase 5+** — Other providers via PR. Each must include a contract test
  against a recorded response so changes to the provider's API surface up.

## 8. Open questions

1. **Multi-org / multi-project users.** OpenAI admin keys can be org-wide;
   some users have multiple orgs. v1 = one credential per provider = one
   number. Multi-org is v1.x.
2. **Rate limits.** When the provider rate-limits sync: keep the last good
   value with a "stale, rate-limited" badge. Never error out the whole view.
3. **Surfacing on the landing page.** Probably not in v1 — too easy to
   misread as "automatic" until the network-posture rule is well understood.
4. **MCP-only services.** Catalog entries that live behind an MCP server (no
   HTTP usage API) won't support sync. That's fine; `supports-usage` is
   per-entry.

## 9. Definition of done

- A user can add a usage credential for at least one provider, click "Sync
  spend", and see a real number in the dashboard within 5 seconds.
- The header badge distinguishes fetched vs typed at a glance.
- `stm sync` works from the CLI.
- The dashboard shows *when* sync last ran per provider.
- The README and landing page state the network-posture rule (§2) verbatim
  next to the feature.
