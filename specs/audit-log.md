# Spec — Audit log

**Status:** Draft · **Target:** v0.3 (between command-policy Phase 2 and Phase 3) · **Last updated:** 2026-05-21

> "A local record of which key each command used."
> Originally on the landing page roadmap; moved off the public card so
> it would not look like we'd already shipped it; kept on the internal
> roadmap in `TODOS.md`. This spec defines it.

## 1. Goal

Give the user a forensic record of every time `PreToolUse` did something
non-trivial — substituted a managed key, blocked because of a missing
key, or applied a policy rule. The record:

- Lives entirely on the user's own machine (matches stm's network
  posture: no telemetry, no phone-home).
- **Records the address of the key (`tool:label`) and never the value.**
  This is a load-bearing invariant — see §5.
- Is bounded in size (it can't grow forever and silently consume disk).
- Is readable from both the dashboard ("Recent decisions" subview on
  the Command policy card) and the CLI (`stm audit`).

The immediate use case is debugging — *"why did Claude Code's command
fail just now?"* — and the longer-term one is policy review — *"which
rules are actually firing? Which keys does this agent really use?"*

## 2. Why now (vs. v1.5)

The Command policy spec defers its audit integration (Phase 4) to this
spec, because:

- Without a log, a `warn` rule's notice is lost the moment the terminal
  scrolls.
- A `deny` rule's reason reaches the agent but not the user looking
  later at what happened.
- A user thinking "did stm even substitute my key?" today has to add
  `set -x` to their command to find out — and `set -x` *prints the
  key*, which is exactly the failure mode stm exists to prevent.

So an audit log is the missing surface that turns "the PreToolUse hook
does something invisible" into "I can see what stm did and why".

## 3. Scope

### Events that get logged

| Event | When written | Why useful |
|---|---|---|
| `substitute` | Successful key substitution | Confirms the hook ran; lets the user trace "command X used key Y" |
| `policy.deny` | Deny rule blocked a command | The rule's id and reason, alongside the command |
| `policy.warn` | Warn rule fired (command still ran) | Carries the same fields as deny; differentiates intent |
| `unresolved` | Placeholder didn't resolve (unknown / revoked key) | Helps diagnose "why did `{{stm:foo:bar}}` not substitute?" |
| `malformed` | Near-miss placeholder, e.g. `{{ stm:foo }}` | A frequent typo class — log it so users see their own mistakes |

### Events that do NOT get logged

- Commands with no stm placeholder. Out of scope and out of value — the
  hook does no work and there's nothing to record.
- `UserPromptSubmit` blocks. These are guardrail events for a chat
  prompt, not a tool invocation; if useful they get their own log.
- `PostToolUse` flags. Same reason — separate event lifecycle. We may
  add a `leak` event in a later revision; deferred.

### Network posture

Logging is **local-only.** No outbound calls, no telemetry, ever. The
network-posture rule from `specs/spend-visibility.md` applies here too:

> stm makes outbound network calls only when you click sync, only to
> the providers you've configured. No background activity, no
> telemetry, no phone-home. Ever.

Audit log has no sync — there is no remote endpoint, period.

## 4. Storage

A new `audit_log` table on the SQLite store:

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT    NOT NULL,                                  -- ISO 8601, UTC
  event      TEXT    NOT NULL CHECK(event IN (
                       'substitute','policy.deny','policy.warn',
                       'unresolved','malformed')),
  tool       TEXT,                                              -- e.g. 'stripe'
  label      TEXT,                                              -- e.g. 'live-secret'
  command    TEXT,                                              -- the bash command, with placeholders (NOT real values)
  agent      TEXT,                                              -- 'claude-code' today
  policy_id  INTEGER REFERENCES policies(id) ON DELETE SET NULL,
  reason     TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_ts_idx     ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_event_idx  ON audit_log(event, ts DESC);
```

Notes:

- `command` is the command in **its un-substituted form** — the same
  string the policy engine sees in `PolicyContext.command`. The real
  secret never lives in the log because the log is written *before*
  substitution is applied.
- `tool` + `label` together address the key. A row's `(tool, label)`
  may refer to a `keys` row that has since been revoked or deleted —
  we keep the row anyway because the audit value is the historical
  record, not a live FK. (Hence: no `REFERENCES keys(id)`.)
- `policy_id` IS a foreign key with `ON DELETE SET NULL` because
  deleting a rule should not erase the history of when it fired; only
  drop the linkage.

## 5. The key-value invariant

> **The audit log must NEVER contain a real key value.**

How this is enforced:

1. The log is written in `PreToolUse` *before* substitution is applied
   to the command. The `command` field holds placeholders, not values.
2. There is no code path that writes the resolved value into the log.
   The Store method that appends a log entry takes `(tool, label,
   command_with_placeholders)`, not the resolved value.
3. Tests assert this: a test seeds a key with a recognizable value,
   runs the hook, and `expect(audit.find(e => e.command.includes(VALUE))).toBeUndefined()`.

This invariant is exactly the same as the chat-transcript invariant —
*the conversation never holds the value* — applied to the audit table.
If we ever add a "show the full pre-substitution command" UI, that
remains placeholder-only.

## 6. Retention

A log that grows without bound will eventually annoy people who run
heavy `set -x`-style commands. Cap it.

**Policy:**

- Soft cap: **10,000 rows.** When `INSERT` would push past it, delete
  the oldest 1,000 rows in the same transaction. This is "rolling
  buffer" semantics, predictable.
- No time-based pruning in v1. (User who wants "last 7 days only" can
  run `stm audit prune --before 7d` — see §8.)
- The cap is overridable via env: `STM_AUDIT_MAX=N`. Useful for tests
  (set low) and for power users (set high).
- The SQLite WAL means rolling buffer pruning is cheap and concurrent.

A future revision can add per-event-class caps (e.g. keep more denies
than substitutes), but the simple total cap is fine for v1 of this
feature.

## 7. UX

### Dashboard

On the existing **Command policy** card, add a third subview below
"Test a command":

```
RECENT DECISIONS                                    [⟳ refresh]
─────────────────────────────────────────────────────────────────
05:21:08 · DENY    {{stm:stripe:live}}   curl -H "auth: …" …
                   rule #1 — no Stripe live keys in dev
05:21:02 · SUB     {{stm:openai:default}}  python script.py …
05:20:58 · UNRES   {{stm:ghost:xx}}      (unknown key)
─────────────────────────────────────────────────────────────────
showing 20 most recent — [load more]   [export CSV]   [clear log]
```

Compact, monospace, colour-coded by event class. Clicking a row opens
a detail panel with the full command and policy id. Pure read view —
no editing.

### CLI

```
stm audit                                   tail the last 20 events
stm audit --tail 100                        last N events
stm audit --event policy.deny               filter by event class
stm audit --tool stripe                     filter by tool
stm audit --since 7d                        time filter (5m, 1h, 7d)
stm audit prune --before 30d                drop everything older than 30d
stm audit prune --keep 5000                 drop oldest beyond N
stm audit clear                             nuke everything (confirms first)
```

Output format is a fixed-width table that aligns with `stm list`.

### Hook integration

`src/hooks.ts:preToolUse()` gains a small `recordEvent` helper. Each
branch of the existing decision tree calls it at the right moment:

- Before `block(...)` for the malformed path → `event='malformed'`.
- Inside the policy block: `event='policy.deny'` on a deny;
  `event='policy.warn'` on a warn.
- Before `block(...)` for unresolved → `event='unresolved'` (one row
  per unresolved placeholder).
- On the success path (`updatedInput` emitted) → one
  `event='substitute'` row per **distinct** placeholder.

Failures of `recordEvent` are swallowed. The audit log is a *secondary*
surface; it must never alter the hook's decision or its fail-safe path.

## 8. Phasing

| Phase | What lands | Why |
|---|---|---|
| **1.** Schema + Store method + PreToolUse integration + `STM_AUDIT_MAX`. | Foundation; closes Phase 4 of Command policy on the back end. |
| **2.** CLI: `stm audit`, `stm audit prune`, `stm audit clear`. | Power-user surface; first thing a developer will use to debug. |
| **3.** Dashboard "Recent decisions" subview + refresh + export + clear. | Visual surface; closes the Command policy card. |
| **4.** Daemon endpoint behind the existing token: `GET /api/audit` with cursor pagination. | Powers the dashboard subview. |

## 9. Open questions

1. **Should we hash long commands** (>500 chars) before storing, to
   keep the table small? Probably not — the WAL handles size fine and
   the verbatim text is useful for debugging. Revisit if real usage
   complains.
2. **Should `stm audit` redact keys-shaped strings in `command` even
   though we already promise they aren't there?** Belt-and-braces;
   could run `detectKeys` over the command at display time and replace
   shaped matches with `<REDACTED>`. Add to Phase 2 unless it gives
   the user a false signal that the log might contain real keys.
3. **`policy.allow` log events?** No — explicit allow rules are rare
   and they're definitionally non-events. Don't double the table for
   no benefit.
4. **Per-project scope?** Once `session-and-project-scope` ships,
   include `project_id` on each row. Phase 3 of this spec, blocked on
   that one shipping.

## 10. Integration with other specs

- **`command-policy.md`** Phase 4 — this spec is the missing dependency.
  When this lands, that Phase can be marked shipped as "the
  Command policy card gains a Recent decisions subview, backed by
  `audit_log`."
- **`session-and-project-scope.md`** — adds a future `project_id`
  column. Soft-dependency; not blocking.
- **`spend-visibility.md`** — orthogonal. Spend visibility records
  what providers say the agent did; audit log records what the local
  hook did. No overlap.

## 11. Definition of done

**Phase 1:**
- [ ] `audit_log` table created on a fresh DB; the test that asserts
      the schema also asserts the key-value invariant (see §5).
- [ ] `Store.recordAudit(...)` appends a row and prunes when over
      `STM_AUDIT_MAX` (default 10,000).
- [ ] PreToolUse writes a row for every `substitute`, `policy.deny`,
      `policy.warn`, `unresolved`, and `malformed` event.
- [ ] A failure inside `recordAudit` is swallowed and never alters the
      hook's exit code or output.

**Phase 2:** `stm audit` and `stm audit prune/clear` work, with
filters specified in §7.

**Phase 3:** Dashboard "Recent decisions" subview renders the last 20
events on `Command policy`, with refresh / export / clear controls.

**Phase 4:** `GET /api/audit?limit=20&cursor=…&event=…&tool=…` returns
paginated rows on the daemon, behind the existing token.
