# Spec — Command policy

**Status:** All four phases shipped (v0.2.5) · **Target:** v0.4 · **Last updated:** 2026-05-22

> "Allow / deny rules at the PreToolUse layer."
> Public roadmap card on subscribetome.pro

This spec turns that one-liner into a concrete design and explains what
problem it solves that Claude Code's built-in permission system **does
not** already solve.

## 1. Goal

Give the user a small, explicit policy language that runs inside stm's
`PreToolUse` hook at the moment a managed key is about to be substituted
into a shell command. Rules can:

- **deny** the substitution (and therefore the command),
- **warn** when the substitution happens (allow with an audit trail),
- **allow** explicitly (so a more permissive rule can sit below a stricter
  catch-all and short-circuit it).

The rule predicate is built from signals stm uniquely sees: **which key**
is being injected, **into what command**, **by which agent**, and (once
project-scope ships) **in which project**.

## 2. Why this isn't already solved

Claude Code already has tool-permission settings — the user can allow
`Bash(npm install:*)` or deny `Bash(rm:*)` from `settings.json`. That
system is great for "is this kind of command allowed at all". It cannot
answer the question stm is in a position to answer:

> "This command tries to use the **Stripe live secret key**. Is that
> allowed in this project, right now?"

Because Claude Code doesn't know what `{{stm:stripe:live-secret-key}}`
means. stm does. Command policy is the secret-aware policy layer that
slots underneath Claude Code's allow-list.

## 3. Non-goals

- **General-purpose command allow/deny.** Use Claude Code's tool
  permissions for that. We are not reinventing it.
- **Output filtering / redaction.** A hook can only *block*, not scrub.
  `PostToolUse` already alerts on leaks.
- **Network-layer enforcement.** A denied substitution stops the
  command from running with the real key; it does not police what the
  agent does over the network with substituted commands that DID run.

## 4. The model

A **policy** is a rule list applied in order at `PreToolUse`, **after**
the set of substitutions is computed but **before** they are applied to
the command. Each rule:

```
ordering:   integer (lower runs first)
when:
  key:      glob       e.g. "stripe:*", "openai:work", "*:*"
  command:  glob       e.g. "rm -rf*", "curl https://api.stripe.com*"
  agent:    glob       e.g. "claude-code", "*"
  project:  glob       (Phase 3 — depends on session-and-project-scope spec)
then:
  action:   allow | deny | warn
  reason:   short string surfaced to the agent
```

A `null` predicate field matches anything. The default action when no
rule matches is **allow** — enforcement is opt-in. A user who wants
default-deny adds a catch-all `{} → deny` rule at the highest ordering.

**First-matching-rule-wins**, where "first" means lowest `ordering`
value. Ties on ordering break by `id` ascending.

### 4.1 Glob semantics

Phase 1 supports one wildcard: `*` matches zero or more characters of
any kind. No `?`, no `[abc]`, no `**`. Two reasons: most policies users
write are list-prefix or list-suffix patterns; introducing regex now
risks footguns when the rule list grows.

If a power user needs regex later, the form `/<pattern>/` is reserved
for that — not implemented in Phase 1.

### 4.2 Evaluating per-substitution

A single command may carry several placeholders. We evaluate the policy
**once per substitution**. The strictest decision wins, in this order:
**deny** > **warn** > **allow** > unmatched. So a command that uses
two keys, one allowed and one denied, is denied.

This is the only sensible semantics for an enforcement layer — a "mostly
ok" decision isn't ok.

## 5. Storage

A new `policies` table is added to the SQLite store. `policy_log` is a
separate sub-spec (the Audit log feature) and is **not** part of this
spec — it'll be added when the audit log spec lands.

```sql
CREATE TABLE IF NOT EXISTS policies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ordering      INTEGER NOT NULL DEFAULT 100,
  when_key      TEXT,                            -- nullable = any
  when_command  TEXT,                            -- nullable = any
  when_agent    TEXT,                            -- nullable = any
  action        TEXT NOT NULL CHECK(action IN ('allow','deny','warn')),
  reason        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS policies_order_idx ON policies(ordering, id);
```

`when_*` columns hold globs as written; matching is done at evaluation
time in TypeScript, not in SQL.

## 6. The hook side

`PreToolUse` flow today:

1. Parse stdin payload.
2. Detect near-misses → block with suggestion.
3. Find exact `{{stm:tool:label}}` matches.
4. Resolve each in the keychain.
5. If any unresolved → block.
6. Rewrite command with real values → emit `updatedInput`.

After this spec, step 4½ becomes:

> 4.5. **Evaluate policy** for each `(tool, label, command, agent)` tuple.
>      If any decision is `deny`, block with the rule's `reason`. If any
>      is `warn`, emit the reason to stderr but continue.

Failure mode is the project's standard: any internal error in policy
evaluation → exit 0 without rewriting → the command runs with the
literal placeholder and simply fails. A failure never leaks a key, and
never bypasses a deny rule (because deny errors fall through to "no
rewrite", which Bash can't execute anyway).

## 7. UX

### CLI (Phase 1)

```
stm policy list                                 list rules, ordered
stm policy add --when-key <glob> [--when-command <g>] [--when-agent <g>]
               --then <allow|deny|warn> [--reason "..."] [--order <n>]
stm policy remove <id>
stm policy test <command>                       dry-run: which rule fires?
```

### Dashboard (Phase 2)

A "Policies" tab. List view with drag-to-reorder. Per-rule form.

### Hooks (Phase 1)

Wired into `PreToolUse` as in §6.

## 8. Examples

```
# Stop the agent from using a Stripe live key in any dev project.
stm policy add \
  --when-key 'stripe:*-live' \
  --then deny \
  --reason "Stripe live keys forbidden by policy. Use a test key."

# Note (but don't block) production OpenAI key usage.
stm policy add \
  --when-key 'openai:prod' \
  --then warn \
  --reason "Production OpenAI key in use"

# Default-deny for one specific tool — only allow it for a curated label.
stm policy add --order 10 --when-key 'aws:dev-readonly' --then allow
stm policy add --order 99 --when-key 'aws:*'           --then deny \
  --reason "Only the aws:dev-readonly key is allowed."
```

## 9. Integration with other specs

- `session-and-project-scope.md` defers scope enforcement to this spec.
  When project-scope ships and a user toggles "Block out-of-scope keys",
  scope generates implicit deny rules with a marker tag. Phase 3 here.
- Audit log spec (TODO) will add a `policy_log` table that records what
  the engine decided, with the matching rule id. This spec does not add
  that table yet.

## 10. Phasing

| Phase | What lands | Status |
|---|---|---|
| **1.** Engine + schema + CLI + hook integration. `deny`/`warn`/`allow`. Test suite. | v0.2.0 (2026-05-21) | **shipped** |
| **2.** Dashboard editor: list, add, remove, dry-run test, all backed by `/api/policies*`. | v0.2.1 (2026-05-21) | **shipped** |
| **3.** Project predicate (`when.project`) + per-project `enforce_scope` toggle. | v0.2.5 (2026-05-22) | **shipped** |
| **4.** Audit log integration — depends on audit-log spec. | v0.2.3 (via `audit-log.md`) | **shipped** |

## 11. Open questions

1. **Per-substitution vs whole-command evaluation.** Spec lands on
   per-substitution + strictest-wins. I think this is right; revisit if
   real usage shows surprising blocks.
2. **Should there be a built-in "shadow" mode?** Same as warn, but the
   user can run a test set against a candidate rule before activating
   it. Defer until someone asks.
3. **Versioning.** When a deny rule was added, prior command history
   pre-dates it. Not a real problem (audit log records the rule id when
   it fires) — but worth surfacing in the dashboard.

## 12. Definition of done (per phase)

**Phase 1:**
- [ ] `policies` table exists; tests cover migration on a fresh DB.
- [ ] `evaluatePolicy({key, command, agent})` returns the right decision
      for a representative rule set.
- [ ] `stm policy add/list/remove/test` work end-to-end.
- [ ] `PreToolUse` blocks a command when a denying rule matches, with
      the rule's `reason` surfaced to the agent.
- [ ] `PreToolUse` warns (stderr) when a `warn` rule matches but still
      substitutes.
- [ ] All existing tests still pass.
