# TODOS

Scoped but-not-yet-built work for subscribetome. The cross-platform-and-
codex.md spec is fully shipped; this file tracks the smaller items that
either don't deserve their own spec (yet) or are waiting on an external
signal before they're worth building.

Items in [`specs/`](./specs/) take precedence over anything here. When
something here grows enough scope to need a design doc, move it to
`specs/` and link back.

Last updated: **2026-09-01** (1.9.0 prep sweep). Everything previously listed
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

## Provider-side key rotation — OpenAI shipped, others pending

`stm rotate <tool> <label> --provider` mints the new key via the
provider's admin API (service-account create), repoints the same
placeholder, and best-effort deletes the old key at the source
(matched by last-4 against the redacted listing; refuses to
guess-delete on 0 or >1 matches). Audited as `rotate.issued` /
`rotate.failed`; outbound network only on the user-initiated command.
Implementation: `src/providers/openai-rotate.ts` +
`test/rotate-provider.test.ts`. OpenAI only; built against the
documented Admin API contract with offline tests — needs one
real-hardware field run (see FIELD_VERIFICATION.md).

**Still pending:** Anthropic / Stripe rotation providers — the
`ROTATION_PROVIDERS` registry makes each one module + one entry +
tests, but each provider's key-management API has its own shape.
Add when there's a concrete ask.

## Retroactive subscription discovery

v1 does not find already-forgotten subscriptions. Receipt /
transaction scanning to surface existing forgotten spend would be a
meaningful adjacent product (the "I cancelled it, I think" use case),
but it's adjacent to the v1 thesis (key safety), not central to it.

Worth its own spec when the v1 surface has shipped publicly long
enough to see whether users actually ask for this.

## ~~PostToolUse warn-only mode~~ (shipped in v0.9.0)

Set `STM_POSTTOOLUSE_MODE=warn` to flip the hook from block-mode
(default, exit 2, interrupts the agent turn) to warn-mode (exit 0,
advisory message to stderr, agent continues). Default unchanged
for users who haven't opted in. Unrecognised values fall back to
block — safer default. See `src/hooks.ts` and
`test/hooks.test.ts` warn-mode test rows.

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
- **Local Playwright provisioning** — the UI suite can't launch
  Chromium locally (browser/version skew vs CI); every local QA pass
  leans on CI or a live-dashboard workaround. Pin or vendor the
  browser so `tests-ui/` runs identically on a dev machine.

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
- **A hosted-by-us cloud service** — stm ships no servers we run.
  (STM Teams, shipped v1.2–v1.6, is *self-hosted* — `stm teams serve`
  on the user's own machine, storing only ciphertext — which stays
  inside this non-goal. The older blanket "no sync, no team mode"
  wording predated Teams and is superseded.)
- **Telemetry of any kind** — stated invariant in README "Security
  model". The reason we have no PostToolUse data and no spend
  forecasts based on user populations.
