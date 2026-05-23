# Specs

The design docs that drive subscribetome's roadmap beyond v1. Every
non-trivial product feature lives here as a markdown spec *before* it
is built, then has its `Status` updated as phases ship.

This index is the source of truth — when a new spec lands, add a row
to the table below and a short summary in §1, then update statuses
here as features ship.

Last updated: **2026-05-23** (session-and-project-scope Phase 3 shipped in v0.2.8 — `stm import` auto-suggest: imports under a matched project now silently extend its scope; imports under an unmatched path surface a one-click "Create project from this path" with the imported keys pre-scoped).

## 1. Index of specs

| # | Spec | Target | Status | Lines |
|---|------|--------|--------|------:|
| 01 | [`cross-platform-and-codex.md`](./cross-platform-and-codex.md) | v2 | Draft | ~280 |
| 02 | [`spend-visibility.md`](./spend-visibility.md) | v0.2 (post-cross-platform) | Draft | ~160 |
| 03 | [`session-and-project-scope.md`](./session-and-project-scope.md) | v0.3 | **All phases shipped** (Phase 1 v0.2.4 · Phase 2 v0.2.7 · Phase 3 v0.2.8) · §7 enforcement via `command-policy` Phase 3 (v0.2.5) | ~230 |
| 04 | [`command-policy.md`](./command-policy.md) | v0.4 | **All four phases shipped** (v0.2.5) | ~230 |
| 05 | [`audit-log.md`](./audit-log.md) | v0.3 | **All four phases shipped** (v0.2.3) | ~200 |
| 06 | [`service-catalog-browser.md`](./service-catalog-browser.md) | v0.3 | **Phases 1–2 shipped** (v0.2.6) · Phase 3 (search/typeahead) deferred | ~280 |

## 2. What each spec covers (one paragraph each)

### 01 — `cross-platform-and-codex.md`
Linux + Windows keychain backends (Secret Service / Credential
Manager) and the conclusion that **OpenAI Codex cannot be a direct port
of the Claude Code design** — Codex has a `PreToolUse` hook but
`updatedInput` is parsed-and-discarded, so we recommend an env-injection
adapter or MCP-wrapped tools instead. Workstreams A (Linux) and B
(Windows) can ship independently; C (Codex) blocks on a working
prototype.

### 02 — `spend-visibility.md`
The second product. Replace the dashboard's manually-typed monthly
cost with **real numbers fetched from provider APIs, on demand, never
automatic**. Anchored to a network-posture rule that we will state
verbatim wherever the feature surfaces: *"stm makes outbound network
calls only when you click sync, only to the providers you've
configured."* Adds a `spend` SQL table and a `SpendProvider`
interface; first provider is OpenAI (admin API), then Anthropic, then
Stripe.

### 03 — `session-and-project-scope.md`
A user with multiple Claude Code sessions open in different projects
shouldn't be told about every key in every session. This spec adds a
`projects` table + per-project `(tool, label)` scope; `SessionStart`
matches `cwd` longest-prefix and renders guidance scoped to only that
project's keys. v1 is **guidance only** — the `PreToolUse` substitution
still works for any managed placeholder. Real enforcement is handed
off to `command-policy.md`'s `when.project` predicate (its Phase 3),
which is the deliberate hook for the scope-enforcement toggle.

### 04 — `command-policy.md`
Allow / deny / warn rules at the `PreToolUse` layer. Anchored to
*"this command tries to use the Stripe live secret. Is that allowed in
this project, right now?"* — a question Claude Code's built-in tool
permissions cannot answer because they don't know what
`{{stm:stripe:live}}` means. The engine evaluates each substitution
against the rule list (first match by `ordering, id`) and collapses
per-command decisions by severity (`deny > warn > allow`). Phases 1
(engine + schema + CLI + hook) and 2 (dashboard editor + four
`/api/policies*` endpoints) shipped on 2026-05-21. Phase 3 (`when.project`
predicate + per-project `enforce_scope` toggle) and Phase 4 (audit log
integration) are both shipped — Phase 3 in v0.2.5 (2026-05-22), Phase 4
via [`audit-log.md`](./audit-log.md) in v0.2.3.

### 05 — `audit-log.md`
A local forensic record of what `PreToolUse` did — every successful
substitution, every policy decision, every unresolved or malformed
placeholder. Crucial design invariant: **the log never contains a
real key value** (the row is written *before* substitution is applied
to the command, with placeholders intact). Storage is a single
`audit_log` table with a rolling 10k-row cap (configurable via
`STM_AUDIT_MAX`). UX is a "Recent decisions" subview on the existing
**Command policy** dashboard card, plus an `stm audit` CLI. Closes
Phase 4 of `command-policy.md`.

### 06 — `service-catalog-browser.md`
A discovery surface on the dashboard. Today's "Add keys" form
assumes the user already knows which provider they want; this spec
adds a browsable, categorized grid of every service stm knows about
above the form. Click a tile → opens the provider's API-keys page
in a new tab + pre-arms the Add keys dropdown + smooth-scrolls to the
form + flashes the card so the user's eye finds it on return. Catalog
grows from 36 to 50 (adds Apollo, Postiz, Typefully, Linear, Notion,
Brevo, Mailgun, Postmark, PlanetScale, Fly.io, Lemon Squeezy, Paddle,
Clay, DigitalOcean). New `category` and `url` fields on every
`ServiceDef`. No outbound calls, no logos, no tracking; preserves
the no-backend posture.

## 3. Dependency graph

```
            ┌──────────────────────────┐
            │ cross-platform-and-codex │  (01)
            │  ⤷ enables non-macOS,    │
            │    non-Claude-Code use   │
            └────────────┬─────────────┘
                         │
                         ▼ (storage abstraction it adds is
                         used by everything below on Linux/Windows;
                         on macOS it has no cross-spec dependency)
                         │
   ┌─────────────────────┼──────────────────────────┐
   ▼                     ▼                          ▼
┌──────────────┐  ┌────────────────────┐  ┌──────────────────┐
│ spend-       │  │ session-and-       │  │ command-policy   │
│ visibility   │  │ project-scope      │  │   (04)           │
│ (02)         │  │ (03)               │  │ Phases 1–2 ✓     │
└──────────────┘  └─────────┬──────────┘  └────────┬─────────┘
                            │                     │
                            │  unlocks            │  unlocks
                            ▼                     │
                  command-policy Phase 3 ◀────────┘
                  (project predicate)              │
                                                   │
                                                   │
                                                   ▼
                                          ┌──────────────────┐
                                          │ audit-log (05)   │
                                          │ closes Phase 4   │
                                          │ of command-policy│
                                          └──────────────────┘
```

Reading the graph:

- `cross-platform-and-codex` is mostly **independent** on macOS — the
  others ship as-is for the v1 platform. Off macOS, it's a hard
  dependency.
- `spend-visibility` has **no cross-spec dependency**. It can ship
  any time.
- `session-and-project-scope` is independent from everything below it
  in the diagram. It unlocks Phase 3 of `command-policy` only
  (the project predicate; not a strict ordering).
- `command-policy` Phase 4 is blocked on `audit-log`. That's the
  most direct ordering constraint on the current roadmap.
- `audit-log` itself has **no upstream blockers** — it can be built
  next.

## 4. Suggested build order

1. ~~**`audit-log.md`** — small spec, small implementation, closes
   Phase 4 of an already-shipped feature (Command policy).~~ **Shipped v0.2.3.**
2. ~~**`session-and-project-scope.md`** Phase 1 — the CLI + SessionStart
   integration.~~ **Shipped v0.2.4.**
3. ~~**`command-policy.md` Phase 3** — the `when.project` predicate +
   per-project `enforce_scope` toggle.~~ **Shipped v0.2.5.**
4. ~~**`service-catalog-browser.md`** — discovery surface on the
   dashboard.~~ **Shipped v0.2.6.**
5. ~~**`session-and-project-scope.md`** Phase 2 — dashboard Projects
   view + `?from=<cwd>` integration.~~ **Shipped v0.2.7.**
6. **`spend-visibility.md`** — the "second product." Worth its own
   launch moment; do not bury inside an unrelated release.
7. **`cross-platform-and-codex.md`** — biggest scope; do after the
   macOS / Claude Code build feels complete.

## 5. Authoring conventions

For consistency across specs:

- Filename is kebab-case, no version suffix.
- Top of the file: `# Spec — <name>` then a single-line `**Status:**`
  / `**Target:**` / `**Last updated:**`.
- One paragraph between the heading and §1 stating the goal in plain
  English.
- Number sections `## 1.`, `## 2.`, …
- Phasing in a markdown table near the bottom.
- A "Definition of done" section before the open questions / phasing
  trailer.
- Cross-spec references via the markdown filename, not relative
  paths: ``[`spend-visibility.md`](./spend-visibility.md)``.
- When a phase ships, update **this index** AND the spec's own
  `Status` line in the same commit.
