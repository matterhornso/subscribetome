# Changelog

All notable changes to subscribetome. This project is pre-1.0; minor versions
may still change behaviour. Format follows [Keep a Changelog](https://keepachangelog.com).

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
