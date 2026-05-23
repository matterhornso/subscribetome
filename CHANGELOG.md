# Changelog

All notable changes to subscribetome. This project is pre-1.0; minor versions
may still change behaviour. Format follows [Keep a Changelog](https://keepachangelog.com).

## [0.3.1] — 2026-05-23

### Added — Linux Secret Service backend (`specs/cross-platform-and-codex.md` Workstream A)

stm is no longer macOS-only. Linux desktop hosts running a libsecret-
compatible keyring daemon (gnome-keyring, kwallet's secret-service
shim) now get a Linux-native KeyStore backend.

- **`KeyStore` interface** in `src/keystores/types.ts` — the abstraction
  seam the spec called for. Every per-OS backend implements `set`,
  `get`, `delete`, `describe`. Two implementation rules are
  load-bearing: secrets are passed via stdin (not argv) wherever the
  underlying tool supports it, and `get` returns null for "not
  found" rather than throwing.
- **macOS backend** (`src/keystores/mac.ts`) — extracted from the v1
  inline `keychain.ts` code, unchanged behavior.
- **Linux Secret Service backend**
  (`src/keystores/linux-secret-service.ts`) — uses `secret-tool`
  (libsecret CLI). The secret is piped via stdin, NOT passed as an
  argv element — a strict posture improvement over macOS's `security
  -w <value>` (which the spec calls out as a known v1 limitation).
- **Resolver** (`src/keystores/index.ts`) with three-tier selection:
    1. `STM_KEYSTORE` override (`mac` / `macos` / `keychain` /
       `linux-secret-service` / `libsecret` / `secret-service` / …)
    2. Platform default — darwin → MacKeychain; linux → LinuxSecretService
       when `secret-tool` is on PATH AND a D-Bus probe succeeds.
    3. Friendly `unsupported` store on platforms with no mapping yet
       (Windows, BSD). The resolver NEVER silently falls back to
       plaintext — the spec calls out gh CLI as the cautionary tale.
- **Active-backend visibility**: `stm status` and the dashboard
  header now show which keystore is live ("macOS Keychain", "Linux
  Secret Service (libsecret)", or the `unsupported (...)` reason).
  Per the spec, the active backend is never hidden from the user.
- `GET /api/inventory` now includes a `keystore` field for the
  dashboard pill.

### Changed
- `src/keychain.ts` is now a thin shim that delegates to
  `getKeyStore()`. The public `keychainSet/Get/Delete` surface is
  unchanged — store.ts, hooks.ts, daemon.ts, and the existing test
  suite see no API drift. 170 tests pass, 0 fail (was 149; +21
  keystore tests).
- README "Limitations (v1)" → "Supported platforms" section
  documenting macOS, Linux desktop, and the still-pending headless
  Linux + Windows roadmap. The v1 "macOS only" claim is retired.
- Landing-page trust strip: "macOS Keychain" → "macOS Keychain ·
  Linux Secret Service".

### Notes
- Headless Linux (SSH, container, WSL) is still unsupported. The
  resolver emits an explicit "no Secret Service reachable" error
  so users know exactly what's wrong. The follow-up tiers
  (`LinuxPass`, `EncryptedFile`) are tracked in
  `specs/cross-platform-and-codex.md` §5.
- Windows (`WindowsCredential`) and the Codex adapter (workstreams
  B and C) are not in this release. The new `KeyStore` interface
  is the seam they will plug into — when they land, they'll be
  one file each behind the same resolver.

## [0.3.0] — 2026-05-23

### Added — Spend visibility (the second product, `specs/spend-visibility.md` Phases 1-3)

The "second product" lands. The dashboard's monthly-spend total is no
longer just what the user typed — for sync-enabled providers it's a
real number pulled from the provider's billing API, on demand, with a
clear "fetched" tag.

**Network-posture rule**, surfaced verbatim on the CLI, the dashboard,
the README, and the landing page:

> stm makes outbound network calls only when you click sync, only to
> the providers you've configured. No background activity, no
> telemetry, no phone-home. Ever.

Concretely:
- **`spend` SQLite table** keyed by `tool_id`, with `fetched_usd`,
  `fetched_at`, `source` (`fetched | error | manual`), and `last_error`.
  Additive migration — opens fine on existing v0.2.x DBs.
- **`SpendProvider` interface** (`src/providers/types.ts`) — pure
  functions over a usage credential; one outbound HTTP call each,
  with injectable `fetch` for testing.
- **OpenAI provider** (`src/providers/openai.ts`) — calls
  `GET /v1/organization/costs?start_time=&end_time=&bucket_width=1d`,
  sums every bucket's `amount.value`. Uses a separate admin key
  (`{{stm:openai:admin-key}}`); never the runtime API key.
- **Anthropic provider** (`src/providers/anthropic.ts`) — calls
  `GET /v1/organizations/cost_report?starting_at=&ending_at=`,
  defensively parses both direct-`amount` and `results[]`-style
  responses. Admin-key based; same separation.
- **Sync orchestrator** (`src/sync.ts`) — resolves the usage
  credential from the keychain, calls the provider, writes either
  `setSpend` on success or `markSpendError` on failure. **Never
  silently zeroes a previous good value on error** (spec §5 invariant
  — covered by a dedicated test).
- **`stm sync [provider]` CLI** — runs every registered provider or
  one named provider. Banner reminds the user of the network-posture
  rule on every invocation. `stm sync --list` enumerates registered
  providers.
- **Dashboard "Sync spend" button** in the header next to the monthly
  total. Three-state pill next to the number:
    - `FETCHED` (emerald)    — every tracked tool has a fetched number
    - `PARTIAL` (amber)      — some fetched, some self-reported
    - `SELF-REPORTED` (grey) — manual ledger only
  Each Subscriptions row gets a tag: `fetched` (emerald, with the
  fetched timestamp in the tooltip), `sync failed` (red, with the
  error message in the tooltip), or no tag (manual).
  A compact monospace sync-log appears under the Subscriptions table
  with one line per provider after a click.
- **Daemon endpoints** (auth + Host/Origin allowlist applies):
    - `GET  /api/spend`        — listSpend + breakdown + provider ids
    - `POST /api/spend/sync`   — `{provider?}` runs one or all
  The existing `GET /api/inventory` now also returns
  `monthlySpendBreakdown`, the `spend` rows, and the registered
  provider ids.
- **Catalog gains `supportsUsage` + `usageCredentialLabel`** fields.
  OpenAI and Anthropic now declare a second credential label
  (`admin-key`) and `supportsUsage: true`. Catalog ↔ providers
  invariant covered by a test.

### Changed
- `Store.monthlySpend()` now prefers `spend.fetched_usd` over
  `tools.monthly_cost` per tool. Users with zero `spend` rows see no
  behavior change — back-compat by construction.
- Landing page (`docs/index.html`): "Spend visibility" promoted out
  of the "next" column into the live "Today" column, with the
  network-posture sentence rendered next to it.
- README: new "Spend sync — network posture" section + `stm sync` in
  the CLI table.

### Notes
- Phase 4 of `specs/spend-visibility.md` (Stripe) is **deferred** —
  per the spec's own framing, your *own* Stripe-account revenue/spend
  is a different category from "AI API spend" and is better modeled
  as a separate "Stripe income" panel. Not built in this release.
- 22 new tests in `test/spend.test.ts` covering store CRUD,
  monthlySpend semantics, provider parsers (both OK and error
  branches), and the orchestrator's "preserve previous value on
  error" rule. Suite: 149 pass, 0 fail (was 127).

## [0.2.8] — 2026-05-23

### Added
- **`stm import` scope auto-suggest (`specs/session-and-project-scope.md`
  Phase 3)** — closes that spec end-to-end. When the dashboard runs an
  import, the request now carries the session's `cwd` (from the
  `?from=` query param that `stm dashboard` sets). The server picks the
  longest-prefix project for that `cwd` and:
    - **Project matched** → silently adds each newly-imported
      `(tool, label)` to that project's `project_scope`. A
      single-line toast on the dashboard confirms ("Scoped N keys to
      <project>"). Imports are *for* the current project; making the
      user re-tick every box afterwards was busywork.
    - **No project matched** → returns a `suggest-create` payload with
      the `cwd`, a suggested project name (the last path segment), and
      the imported `(tool, label)` list. The dashboard renders an
      inline banner under the import message with a **Create project**
      button — one click creates the project at the cwd and scopes
      all imported keys to it in one batch.
- `importSelected(selections, { cwd, dbPath? })` — new option object.
  `cwd` triggers the Phase 3 logic; `dbPath` is the existing `STM_DB`
  test seam promoted to the API signature for unit-test ergonomics.
- New result field `scopeUpdate: ScopeUpdate | undefined` on
  `importSelected`. Discriminated union: `kind: "added-to-existing"`
  carries `projectId / projectName / projectPath / addedToScope[]`;
  `kind: "suggest-create"` carries `cwd / suggestedName / imported[]`.

### Changed
- `POST /api/import/confirm` body now accepts an optional `cwd` field
  alongside `selections`. Existing callers that don't send `cwd` get
  the historical `{imported, errors}` shape — no regression.

### Notes
- This release closes `specs/session-and-project-scope.md` end-to-end
  (all three phases + §7 enforcement). The 3 remaining spec items on
  the public roadmap are `spend-visibility.md`,
  `cross-platform-and-codex.md`, and the deferred Phase 3 of
  `service-catalog-browser.md` (search/typeahead).
- Default behaviour for users without registered projects, or who
  open the dashboard manually (no `?from=`), is unchanged — the
  import flow is back-compat.

## [0.2.7] — 2026-05-22

### Added
- **Dashboard Projects card (`specs/session-and-project-scope.md`
  Phase 2)** — a new card under "API keys" lists every registered
  project as a row showing:
    - Name + canonical path
    - The in-scope `(tool, label)` pairs as click-to-copy placeholder
      pills (same UX as the API keys table)
    - An **Enforce** checkbox that toggles `enforce_scope` (was already
      wired into PreToolUse by v0.2.5; now toggle-able from the UI)
    - **Edit scope** → expands a checklist of every active key the
      user has stored; tick/untick to add/remove from this project's
      scope. Each toggle hits the API immediately — no save button.
    - **Remove** (with a confirm prompt).
  Below the list, an inline "Add a project" form (path + name).
- **Session signal (`?from=<cwd>`)** — when `stm dashboard` opens the
  browser it now appends `?from=<encoded cwd>` to the URL. The
  dashboard parses that, calls a new
  `GET /api/projects/match?cwd=` endpoint, and renders a small
  emerald-tinted banner at the top:
    - Matched project →
      "Session in **<name>** · N keys in scope · `<path>`" + an
      **Edit scope** button that expands that project's row.
    - No match →
      "Session in `<cwd>` · no project matches this path" + a
      **Create project from this path** button that pre-fills the
      Add-project form with the cwd and the last-segment name,
      scrolls + flashes the Projects card, and focuses the name
      field so the user can confirm.
- New daemon endpoints (auth + Host/Origin allowlist applies):
    - `GET /api/projects` — list + scope + enforce flag for every
      project, one fetch.
    - `POST /api/projects` — add (`{path, name}`).
    - `PATCH /api/projects/:id` — rename (`{name}`).
    - `DELETE /api/projects/:id` — drop project + cascade scope.
    - `POST /api/projects/:id/scope` — add `{tool, label}` to scope.
    - `DELETE /api/projects/:id/scope` — remove `{tool, label}` from
      scope.
    - `GET /api/projects/match?cwd=` — longest-prefix lookup; returns
      `{project, cwd}` with `cwd` normalized through the same path
      canonicalization the store applies on writes (so the round-trip
      via "Create project from this path" is idempotent).

### Changed
- `stm dashboard` (`openDashboard` in `daemon.ts`) now appends
  `&from=<encodeURIComponent(process.cwd())>` to the URL it `open`s.
  The token-bearing URL still never goes to stdout; the `?from` value
  is the same `cwd` the agent itself has, so it's nothing
  conversation-sensitive.

### Notes
- This release closes Phase 2 of `specs/session-and-project-scope.md`.
  Phase 3 (the `stm import` auto-suggest "create a scope from these
  imported keys" flow) is the last remaining piece of that spec.
- Default behaviour for users without any registered projects is
  unchanged: the session signal hides itself when no project matches
  AND the URL has no `?from`, and the Projects card just shows the
  empty-state nudge.

## [0.2.6] — 2026-05-22

### Added
- **Service catalog browser (`specs/service-catalog-browser.md` Phases 1–2)** —
  a discovery surface on the dashboard. New "Browse services" card sits
  above "Add keys" and lists every catalog entry as a categorized grid of
  tile buttons. Clicking a tile:
    1. Opens the provider's API-keys page in a new tab (plain
       `target="_blank" rel="noopener noreferrer"` — no tracking, no
       redirect, no UTM).
    2. Pre-selects that service in the Add keys dropdown so the right
       credential fields are already rendered when the user comes back.
    3. Smooth-scrolls the dashboard to the Add keys card and triggers a
       1.5-second emerald-outline flash so the user's eye finds the form.
- **Catalog grew from 36 to 50 services.** 14 net-new entries:
    - **Sales & outreach**: Apollo, Clay
    - **Social media**: Typefully, Postiz
    - **Dev tools**: Linear, Notion
    - **Email**: Brevo, Mailgun, Postmark
    - **Database**: PlanetScale
    - **Hosting**: Fly.io, DigitalOcean
    - **Payments**: Lemon Squeezy, Paddle
- New `category` and `url` fields on every `ServiceDef`. `category` is a
  closed `ServiceCategory` union (12 buckets — AI, database, hosting,
  auth, payments, email, comms, social, sales, search, monitoring, vcs).
  `url` is the provider's API-keys settings page (HEAD-checked at build
  time; signup root substituted with a `// FIXME` comment for any 404).
- New exports `CATEGORY_LABEL` (display names) and `CATEGORY_ORDER`
  (render order) drive the dashboard browser without baking strings into
  the HTML template.

### Changed
- Landing page `description` and trust strip now read **"50 services
  pre-configured"** (was 36). `docs/llms.txt` paragraph updated with the
  full provider list and a note about the browser card. JSON-LD
  `softwareVersion` bumped to 0.2.6.

### Notes
- No outbound network calls at runtime. Provider URLs are bundled into
  the catalog at build time; the dashboard never fetches anything from a
  provider. Matches the project's no-backend / no-phone-home posture.
- No tracking on outbound clicks. Plain `noopener noreferrer` so the
  provider sees a direct visit and `subscribetome.pro` never sees the
  hop.
- The existing Service dropdown stays exactly as before — power users
  who already know what they want skip the browser entirely. The
  browser is additive discovery.
- Phase 3 (search box + keyboard navigation) is deferred to v2.

## [0.2.5] — 2026-05-22

### Added
- **`when.project` policy predicate (Phase 3 of `specs/command-policy.md`)** —
  policy rules can now narrow to a specific project. The hook resolves the
  session's `cwd` via `Store.matchProject` (longest-prefix) and passes the
  project name into the policy engine; a rule's `when_project` glob matches
  that name. Empty project = no match → only `*` or null fires.
- **Per-project scope enforcement** — every project now carries a
  `enforce_scope` flag (0 = guidance-only, default; 1 = enforce). When ON,
  `PreToolUse` denies any substitution whose `(tool, label)` isn't in the
  project's `project_scope` rows. The deny is logged with `policy_id = NULL`
  and a reason starting `"scope enforcement:"` — distinguishable from a
  user-authored deny rule.
- New CLI:
    `stm policy add --when-project <glob>`     attach the new predicate
    `stm project enforce <path> <on|off>`      toggle scope enforcement
- `stm policy list` adds a Project column; `stm project list` adds an
  Enforce column; `stm project show` displays the enforcement state.
- New daemon endpoint: `POST /api/projects/:id/enforce {on: boolean}`.
  `POST /api/policies` now accepts an optional `whenProject` field.
  `POST /api/policies/test` accepts an optional `cwd` to simulate the
  project predicate firing inside a given directory.

### Changed
- SQLite schema: `policies.when_project TEXT` and
  `projects.enforce_scope INTEGER NOT NULL DEFAULT 0`. Both are additive,
  applied at `Store` construction via PRAGMA-introspected `ALTER TABLE` —
  idempotent and safe on existing DBs (opening the same DB twice is a
  no-op).
- `PolicyRule.when_project: string | null` and `PolicyContext.project:
  string` are now part of the engine surface. The `project` field defaults
  to `""` for callers that don't supply one, so existing rules with a null
  predicate behave identically to before.

### Security
- Load-bearing invariant from `specs/audit-log.md` §5 re-validated: every
  branch — including the synthetic scope-enforcement deny — writes the
  un-substituted command. A new test seeds two recognizable secrets,
  exercises the scope-enforcement path, and asserts no audit row contains
  either seeded value.

### Notes
- This release closes `specs/command-policy.md` end-to-end (all four
  phases) and fulfils `specs/session-and-project-scope.md` §7
  (enforcement toggle). Phase 2 of session-and-project-scope (dashboard
  Projects view + `?from=<cwd>`) is the next remaining piece.

## [0.2.4] — 2026-05-22

### Added
- **Per-project key scope (`specs/session-and-project-scope.md` Phase 1)** —
  multi-session, multi-project users can now register projects and scope
  specific `(tool, label)` pairs to each one. When a Claude Code session
  opens in a path that matches a registered project (longest-prefix wins),
  `SessionStart` appends a "PROJECT SCOPE" section to its guidance listing
  ONLY that project's keys — the model is told about the relevant
  placeholders for this work, not the global 30+ inventory.
- New SQLite tables: `projects (id, path UNIQUE, name, created_at)` and
  `project_scope (project_id, tool_id, label)` with `ON DELETE CASCADE`
  on both foreign keys. Path index for fast lookup.
- New `stm project` CLI subcommand suite:
    `stm project add <path> <name>`
    `stm project list`
    `stm project show <path>`
    `stm project scope <path> <tool>:<label>`
    `stm project unscope <path> <tool>:<label>`
    `stm project rename <path> <new-name>`
    `stm project remove <path>`
- Path normalization: `~` expands to home; trailing slashes stripped;
  `..` / `.` resolved.

### Changed
- `SessionStart` hook now parses its stdin payload (used to drain and
  discard) and reads `cwd`. Falls back to `process.cwd()` on malformed
  input. Behaviour for users without any registered projects is
  identical to before — adopting scope is opt-in.

### Notes
- Scope is **guidance only** in this release. The `PreToolUse` hook
  still substitutes any managed placeholder regardless of project.
  Enforcement is `command-policy.md` Phase 3 (the `when.project`
  predicate), now unblocked.

## [0.2.3] — 2026-05-22

### Added
- **Audit log CLI (Phase 2 of `specs/audit-log.md`)** — a complete
  `stm audit` subcommand surface:
  - `stm audit [--tail N] [--event <class>] [--tool <name>] [--since <dur>]`
    tails the log most-recent-first as a fixed-width table.
  - `stm audit prune --before <dur>` drops rows older than a friendly
    duration (5m / 1h / 7d).
  - `stm audit prune --keep <N>` keeps only the N most-recent rows.
  - `stm audit clear` (refuses without `--yes` in interactive
    terminals).
- **Audit log dashboard subview (Phase 3)** — a "Recent decisions"
  section on the existing Command policy card. Compact monospace
  table with colour-coded event badges (`policy.deny` red,
  `policy.warn` amber, `unresolved` amber, `substitute` emerald,
  `malformed` grey). Filters: event class dropdown + tool input.
  Refresh + Clear log buttons. Renders the un-substituted command
  every time — same load-bearing invariant as the storage layer.
- **Audit log daemon API (Phase 4)** — two new authenticated endpoints
  behind the existing token + Host/Origin allowlist:
    - `GET /api/audit?limit=&event=&tool=` (limit clamped to [1,500],
      bad event class → 400)
    - `POST /api/audit/clear`

### Changed
- `Store.listAudit` now accepts an optional `sinceISO` filter.
- `Store.pruneAudit({ beforeISO?, keepNewest? })` is the new pruning
  primitive used by both the CLI and the rolling-buffer.

### Notes
- This release closes `specs/audit-log.md` end-to-end (all four
  phases). It also fulfils Phase 4 of `specs/command-policy.md`,
  which was waiting on audit-log integration.

## [0.2.2] — 2026-05-21

### Added
- **Audit log (Phase 1)** — every `PreToolUse` decision now writes a
  forensic row to a new `audit_log` SQLite table. Five event classes:
  `substitute`, `policy.deny`, `policy.warn`, `unresolved`, `malformed`.
  Rolling 10,000-row cap (configurable via `STM_AUDIT_MAX`), with
  pruning batched inside the same insert transaction.

### Security
- Load-bearing invariant enforced by construction: **the audit log
  never contains a real key value**. Rows are written before
  substitution is applied to the command, with placeholders intact.
  An integration test seeds a recognizable key, exercises all five
  event-class branches, and asserts no audit row anywhere contains
  the seeded value. See `specs/audit-log.md` §5.
- `audit_log.policy_id` has `ON DELETE SET NULL` so removing a rule
  clears the linkage but preserves the historical record of when it
  fired. Tested.

### Notes
- Phase 2 (CLI: `stm audit`), Phase 3 (dashboard "Recent decisions"
  subview), and Phase 4 (`GET /api/audit` endpoint) are pending.
  Phase 1 closes the back-end half of `command-policy.md` Phase 4.

## [0.2.1] — 2026-05-21

### Added
- **Command policy in the dashboard (Phase 2)** — a new "Command policy"
  card in `/stm:dashboard` for managing rules visually:
  - A table of every rule (ordered ASC, with a Remove button per row).
  - An "Add rule" inline form: three glob inputs (key / command / agent),
    action select, order, reason, Add button.
  - A "Test a command" widget — paste a Bash command with `{{stm:…}}`
    placeholders, get back a coloured verdict card (deny / warn / allow),
    the matching rule id, the reason, and per-substitution detail.
- 4 new daemon endpoints behind the localhost-only auth token: `GET
  /api/policies`, `POST /api/policies`, `DELETE /api/policies/:id`, and
  `POST /api/policies/test`.

### Changed
- Dashboard token palette gains explicit `deny` / `warn` / `allow` badge
  variants; verdict card borders tint by severity.

## [0.2.0] — 2026-05-21

### Added
- **Command policy (Phase 1)** — `stm policy {list|add|remove|test}`. Rules
  are evaluated inside the `PreToolUse` hook **before** the keychain is
  consulted, so a deny rule prevents a key from ever being read for a
  rejected command. Predicates are glob patterns over `(key, command,
  agent)`; actions are `allow` / `deny` / `warn`; first-matching rule wins
  by `ordering` then `id`; per-substitution decisions collapse with
  severity `deny > warn > allow`. New `policies` table on the SQLite
  store. Default action when no rule matches is still `allow` (opt-in
  enforcement). Dashboard editor and project predicate land in later
  phases — see [`specs/command-policy.md`](./specs/command-policy.md).

## [0.1.9] — 2026-05-20

### Added
- **Parallel Web Systems** (parallel.ai) added to the dashboard catalog.
  Single `api-key` field. Landing-page trust strip now reads "36 services
  pre-configured".

## [0.1.8] — 2026-05-19

### Added
- **Custom fields** in the dashboard's "Add keys" form: after a service's
  standard fields, an "+ Add another field" button lets you store extra
  credentials a provider needs under your own label (e.g. a `jwt-secret` for
  Supabase). Each row is a label + value you can remove.

### Changed
- Maintainer contact updated to `abhinav@matterhorn.so`.

## [0.1.7] — 2026-05-19

### Changed
- Expanded the dashboard service catalog from 10 to **35 researched services** —
  AI/LLM providers (OpenAI, Anthropic, Gemini, Groq, Mistral, OpenRouter, fal,
  Replicate, ElevenLabs), databases (Supabase, Neon, MongoDB Atlas, Upstash,
  Firebase), hosting (Vercel, Netlify, Railway, Cloudflare, AWS), auth (Clerk,
  Auth0), Stripe, comms (Resend, SendGrid, Twilio, Slack, Telegram, Discord),
  Twitter/X, search (Tavily, Firecrawl, Exa), monitoring (Sentry, PostHog),
  GitHub. Each carries its real credential field names.

## [0.1.6] — 2026-05-19

### Added
- **Service catalog picker** in the dashboard: choose a service and the form
  lays out its standard credential fields (Supabase → service-role-key /
  anon-key / db-password; Twitter → its five tokens; etc.). Fill what you have,
  one click adds them all. "Other" keeps the free-form tool + label flow.
- `UserPromptSubmit` now also blocks a prompt containing any **secret stm
  manages, matched by exact value** — catches plain passwords with no key shape.

## [0.1.5] — 2026-05-19

### Added
- **SessionStart hook**: every Claude Code session is automatically taught how
  to use stm-managed keys — no `CLAUDE.md` or config edit required.

## [0.1.4] — 2026-05-19

### Changed
- Renamed the plugin `subscribetome` → **`stm`**. Slash commands are now
  `/stm:dashboard`, `/stm:inventory`, `/stm:import`, `/stm:revoke`. Install is
  `claude plugin install stm@subscribetome`.

### Fixed
- Keychain service name is now resolved per-call, not frozen at module load,
  so the test suite's seed process and its spawned hook subprocesses share one
  keychain service.

## [0.1.3] — 2026-05-19

### Added
- **Click-to-copy placeholders** in the dashboard, with a toast.
- **Editable subscriptions**: set or change a tool's plan, monthly cost, and
  renewal date directly in the dashboard, independent of adding a key.

## [0.1.2] — 2026-05-18

### Added
- Marketing landing page (`docs/index.html`, served via GitHub Pages).

### Changed
- Redesigned the dashboard with a three-layer design-token system.

## [0.1.1] — 2026-05-18

### Fixed
- Removed the `hooks` field from `plugin.json`: Claude Code auto-loads
  `hooks/hooks.json`, and declaring it twice caused a duplicate-hooks load
  failure that left the plugin unable to load.

## [0.1.0] — 2026-05-18

### Added
- Initial release. A Claude Code plugin: out-of-band key entry, macOS Keychain
  storage, and three hooks — `PreToolUse` (injects real keys into commands via
  placeholder substitution), `UserPromptSubmit` (blocks a raw key in chat),
  `PostToolUse` (flags a key leaked into output).
- The `stm` CLI, the localhost dashboard daemon, and `.env` import.

[0.3.1]: https://github.com/matterhornso/subscribetome/releases/tag/v0.3.1
[0.3.0]: https://github.com/matterhornso/subscribetome/releases/tag/v0.3.0
[0.2.8]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.8
[0.2.7]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.7
[0.2.6]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.6
[0.2.5]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.5
[0.2.4]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.4
[0.2.3]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.3
[0.2.2]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.2
[0.2.1]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.1
[0.2.0]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.0
[0.1.9]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.9
[0.1.8]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.8
[0.1.7]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.7
[0.1.6]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.6
[0.1.5]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.5
[0.1.4]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.4
[0.1.3]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.3
[0.1.2]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.2
[0.1.1]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.1
[0.1.0]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.0
