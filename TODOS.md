# TODOS

Scoped but-not-yet-built work for subscribetome. The cross-platform-and-
codex.md spec is fully shipped; this file tracks the smaller items that
either don't deserve their own spec (yet) or are waiting on an external
signal before they're worth building.

Items in [`specs/`](./specs/) take precedence over anything here. When
something here grows enough scope to need a design doc, move it to
`specs/` and link back.

Last updated: **2026-05-25** (v0.7.1 sweep). Everything previously listed
under "shipped in subsequent releases" was removed; items below are the
genuinely-pending backlog.

---

## Managed-manager import (1Password / Doppler / Infisical)

v1 import covers `.env` files only. Importing from a managed secrets
manager by *copying* the value duplicates the secret and goes stale when
the manager rotates it. The right shape is integration by **pointer** —
store a reference (e.g. `op://Personal/openai/api-key`) and re-fetch the
live value at injection time inside the PreToolUse hook.

**Why not built yet:** each manager has its own auth + read API; one
provider integration is meaningful work, three is a small project.
Worth a dedicated spec when there's a concrete user asking for one
manager in particular.

**Acceptance criteria for a future build:**
- New `source` enum value on the `keys` row: `pointer-1password` /
  `pointer-doppler` / `pointer-infisical`.
- KeyStore resolves the pointer at every read (cached for the
  process lifetime to keep PreToolUse latency low).
- Dashboard shows the pointer + an "↻ live" badge.
- `stm doctor` reports whether each configured manager is reachable.

## Provider-side key rotation

v1 `stm revoke` is a metadata flag — it marks the key as not-to-be-used
locally but does not call the provider's API to actually issue a new
key + revoke the old one. Real rotation is provider-specific surface
area: OpenAI, Anthropic, Stripe, etc. all expose key-management APIs
with different shapes.

**Why not built yet:** deferred until there's a concrete provider to
support first, so we don't ship five half-baked integrations. Most
likely first target: OpenAI's admin API (already used for spend sync,
so the credential pattern is already wired).

**Acceptance criteria for a future build:**
- `stm rotate <tool> <label>` — issues a new key via the provider API,
  writes it to the keychain under the same label, marks the old key
  revoked.
- Audit-log event class: `rotate.issued` / `rotate.failed`.
- Network-posture rule still holds: outbound only on user-initiated
  `stm rotate` (same shape as `stm sync`).

## Retroactive subscription discovery

v1 does not find already-forgotten subscriptions. Receipt /
transaction scanning to surface existing forgotten spend would be a
meaningful adjacent product (the "I cancelled it, I think" use case),
but it's adjacent to the v1 thesis (key safety), not central to it.

Worth its own spec when the v1 surface has shipped publicly long
enough to see whether users actually ask for this.

## PostToolUse warn-only mode

PostToolUse currently *blocks* a tool result that contains a key,
interrupting the model. Whether that's right depends on how often it
fires in practice. A user-configurable mode (block vs warn-only)
would let a power user choose interruption-vs-flag.

**Why not built yet:** we have no telemetry by design, so we have no
data on how often PostToolUse fires. Defer the toggle until a user
asks (or surfaces a real interruption regression).

---

## Spec-tracked deferred items

For visibility, the spec files explicitly defer these — see the
linked specs for the rationale:

- **Service-catalog Phase 3 — search/typeahead** in
  [`specs/service-catalog-browser.md`](./specs/service-catalog-browser.md)
  §3. Deferred until usage shows category browsing isn't enough.
- **Stripe spend panel** — Phase 4 of
  [`specs/spend-visibility.md`](./specs/spend-visibility.md). Deferred
  per the spec's own framing: Stripe revenue belongs in a separate
  "Stripe income" panel, not the spend totals.
- **Audit log `leak` event class** —
  [`specs/audit-log.md`](./specs/audit-log.md) §6. Deferred until
  there's a real forensics use case driving the schema.

## External blockers

- **Codex per-command rewrite** — would let stm offer the same
  "transcript-clean per-command" guarantee on Codex that Claude Code
  offers today. Blocked on
  [`openai/codex#18491`](https://github.com/openai/codex/issues/18491);
  when it lands, the v0.4.0 launcher template is the worked example.
  Today's Codex coverage is two modes side-by-side: Option 1
  (session-env, v0.4.0) and Option 2 (MCP-wrapped, v0.7.0).

## Candidates surfaced post-v1 (no spec yet)

These came out of discussion during v0.4–v0.7 builds. Each would
need a small spec before building.

- **More MCP providers** for v0.7.0 — the launch set is OpenAI,
  Anthropic, Stripe, GitHub, Resend. The registry pattern
  (`src/agents/codex-mcp-providers.ts`) is one entry + one test per
  addition. Natural next: Replicate, ElevenLabs, Tavily, Firecrawl,
  Slack, Discord (matches the dashboard catalog).
- **opencode / Cursor adapters** — opencode has its own hook system
  (similar shape to Codex per its docs); Cursor doesn't, so it'd be
  a session-env model only. The v0.4.0 Codex launcher template is
  the reference. Each adds a row to the Compatibility-agents table
  in the README.
- **Spend forecasting** — the v0.3.0 spend sync gives us month-to-
  date data; projecting month-end + warning when a budget is crossed
  is a Subscriptions-card extension. No spec yet.

## Field verification (smoke-tested but unverified on real hardware)

See [`FIELD_VERIFICATION.md`](./FIELD_VERIFICATION.md). The v0.5,
v0.6, and v0.7 builds were done on macOS; the Windows + Linux-
headless + Codex paths still need a real user on a real host to
confirm the FFI / MCP / passphrase paths beyond the synthetic
smoke tests. Community reports welcome.

## Explicit non-goals (NOT a TODO)

For reference. These are out of scope by design, listed here so the
backlog doesn't accidentally pretend otherwise:

- **Mobile / browser agents** — explicit non-goal in
  `specs/cross-platform-and-codex.md` §1.
- **Hosted / cloud / sync component** — explicit non-goal in the
  same spec. stm stays local-only, no servers.
- **Team mode** — depends on hosted/sync, so same non-goal until
  the non-goal itself is revisited.
- **Telemetry of any kind** — stated invariant in README "Security
  model". The reason we have no PostToolUse data and no spend
  forecasts based on user populations.
