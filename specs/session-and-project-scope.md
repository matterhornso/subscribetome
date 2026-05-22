# Spec — Per-project key scope (multi-session, multi-project)

**Status:** Phases 1 (v0.2.4) + 2 (v0.2.7) + §7 enforcement (v0.2.5 via `command-policy.md`) shipped · Phase 3 (import auto-suggest) pending · **Target:** v0.3 · **Last updated:** 2026-05-22

A user with a real workflow has **multiple Claude Code sessions open at once,
each in a different project directory**. With 36 catalog services and custom
fields, the global key list is too big to be useful per-session: every session
sees every key, every project's `SessionStart` guidance is the same long
manifest. Worse, the model might reach for a key meant for a different
project — e.g. the wrong customer's Supabase service-role key, used in a
command that runs *now*.

This spec adds project scoping. Each project declares which keys are
in-scope; each Claude Code session is teached only about *that* project's
keys; the dashboard shows the user, at a glance, which project a session
maps to.

## 1. Goal

> "When I open Claude Code in `~/code/acme-app`, that session should only
> know the keys this project actually uses — and I should be able to see
> exactly which ones at a glance."

Concretely:

- The `SessionStart` hook reads the session's `cwd`, finds the matching
  project, and emits guidance scoped to **only that project's keys**.
- The dashboard has a **Projects** view: the user can register a project
  (path + name) and pick which `(tool, label)` pairs are in scope.
- `PreToolUse` substitution still works for any managed placeholder — scope
  is a *guidance* mechanism, not an authorization one (see §6).
- When no project matches the session's `cwd`, behavior is **unchanged
  from today** (all keys in scope). Adopting scope is opt-in.

### Non-goals (v1 of this feature)

- Project-level access control / authorization. The `PreToolUse` hook still
  substitutes any valid placeholder the model writes. This is a discovery
  and guidance feature, not an enforcement layer. (Enforcement is a
  follow-up; see §7.)
- Multi-host project sharing. Project records are local; no cloud sync.
- Auto-detecting a project from `git remote` or `package.json`. Path-based
  only in v1.

## 2. The user-visible model

**A project** is `{ path, name, scope[] }` where `scope[]` is a list of
`(tool, label)` pairs the user has marked relevant for this project.

**Matching:** the `SessionStart` hook's `cwd` is matched against project
paths by **longest-prefix wins**. `~/code/acme-app` and
`~/code/acme-app/landing` are two projects; a session opened in the landing
subdir picks the more specific one. No match → unchanged guidance (all
keys).

**Why path-based, not git-remote-based.** Sessions can run before a remote
is configured, in worktrees, or in unrelated repos colocated under one
parent. `cwd` is the one signal that's always available at `SessionStart`.

## 3. UX

### Dashboard — Projects view

A second section under the existing service picker:

```
┌───────────────────────────────────────────────┐
│ Projects                            + Add ▼   │
├───────────────────────────────────────────────┤
│ ● acme-app                  ~/code/acme-app   │
│   openai:default   supabase:service-role-key  │
│   stripe:secret-key                    [edit] │
│                                               │
│ ● internal-tools           ~/code/internal    │
│   openai:work   anthropic:default             │
│   neon:database-url                    [edit] │
└───────────────────────────────────────────────┘
```

- "+ Add" prompts for a path (Browse… opens a folder picker) and a name.
- Scope is edited as a checklist of every `(tool, label)` the user has
  stored — pick the ones this project uses.
- A project view also surfaces ready-to-copy placeholders for the in-scope
  keys, so the user can read them off the dashboard.

### Dashboard — header signal

When the dashboard is opened from inside a Claude Code session
(`/stm:dashboard`), the URL includes `?from=<cwd>`. The header reads:

> Session in **acme-app** · 3 keys in scope

If no project matches: `Session in <path> · no scope set` with a one-click
"Create project from this path" affordance. This is the place where most
users will first encounter the feature.

### CLI

```
stm project add <path> <name>            register a project
stm project scope <path> <tool>:<label>  add a key to its scope
stm project unscope <path> <tool>:<label>
stm project list                         summary table
stm project show <path>                  full scope + placeholders
stm project rename <path> <new-name>
stm project remove <path>
```

`stm dashboard` always opens the projects view if the cwd matches a project.

## 4. The hook side

`SessionStart` already returns guidance text via `additionalContext`. The
change is: render that text from the scoped key list, not the full
inventory.

Pseudo:

```ts
function sessionStart(input: HookInput): HookOutput {
  const cwd = input.cwd ?? process.cwd();        // Claude Code provides cwd
  const project = store.matchProject(cwd);        // longest-prefix match
  const keys = project
    ? store.scopedKeys(project.id)
    : store.allActiveKeys();                       // unchanged fallback

  const header = project
    ? `Session in project **${project.name}** (${project.path}). ${keys.length} keys in scope.`
    : `${keys.length} keys available across all projects.`;

  return { additionalContext: header + "\n\n" + renderManifest(keys) };
}
```

The current `SESSION_GUIDANCE` constant stays — it teaches *how* to use
stm. The per-key manifest is what gets scoped.

`PreToolUse`, `UserPromptSubmit`, `PostToolUse` are unchanged. They still
operate on the global key store.

## 5. Storage

Two new tables. The `tools` and `keys` tables stay as they are.

```sql
CREATE TABLE projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE project_scope (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tool_id     INTEGER NOT NULL REFERENCES tools(id)    ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  PRIMARY KEY (project_id, tool_id, label)
);

CREATE INDEX projects_path_idx ON projects(path);
```

`matchProject(cwd)` does `SELECT … FROM projects WHERE ? LIKE path || '%'
ORDER BY length(path) DESC LIMIT 1`. (Real implementation normalizes paths
and uses a prefix check, not LIKE, to avoid pathological cases.)

## 6. Why this is *guidance*, not enforcement

A natural next question: "If I mark project X as openai-only, can the model
*still* use a Stripe placeholder?"

In v1 of this feature, **yes**. `PreToolUse` substitutes any
syntactically valid placeholder the model writes that maps to a stored
key. Reasons:

1. **Fail-safe wins.** A guidance scope that silently blocks substitution
   makes commands fail in surprising ways and breeds workarounds.
2. **The signal-to-noise win is already large.** Just *not telling* the
   model about other keys means it won't reach for them in 95%+ of cases.
3. **Real enforcement is a separate feature** — `Command policy` from the
   landing page roadmap. That ships as a separate spec with a clear
   "block when scope doesn't match" mode, opt-in per project.

The dashboard explains this in plain words next to the scope editor: "Scope
controls what each session is told about. It does not block other keys."

## 7. Scope enforcement (shipped v0.2.5 via `command-policy.md` Phase 3)

A per-project toggle:

> ☐ Block substitution of out-of-scope keys for this project

When on, `PreToolUse` checks the substitution target's `(tool, label)`
against the matched project's scope, and refuses to substitute if not
in scope. The model sees the un-substituted placeholder and surfaces the
miss; user knows immediately. The deny is logged to the audit table with
`event = "policy.deny"`, `policy_id = NULL`, and a reason starting with
`"scope enforcement:"` — distinguishing it from a user-authored rule hit.

UX: `stm project enforce <path> <on|off>` toggles the flag from the CLI;
`stm project show` displays the current enforcement state.

## 8. Phasing

| Phase | What lands | Released | Status |
|---|---|---|---|
| **1.** `projects` + `project_scope` tables. `SessionStart` reads `cwd` and emits scoped guidance. `stm project add/list/show/scope/unscope/rename/remove` CLI. | v0.2.4 (2026-05-22) | **shipped** |
| **2.** Dashboard Projects view + `?from=<cwd>` integration on `/stm:dashboard`. | v0.2.7 (2026-05-22) | **shipped** |
| **3.** Auto-suggest: when `stm import` runs in a project that doesn't have a scope yet, offer to create one from the imported keys. | After Phase 2 | pending |
| **4** (separate spec). Enforcement toggle via Command policy's `when.project` predicate. | v0.2.5 (2026-05-22) | **shipped** (in [`command-policy.md`](./command-policy.md) Phase 3) |

## 9. Open questions

1. **Worktrees.** A single project with N git worktrees has N paths. v1
   answer: each worktree path can be its own project entry, or the user
   registers the parent dir as the project (most common: each worktree
   *is* the project). Document this.
2. **The "no scope" experience.** Today's behavior is "all keys", which
   is a big manifest. Once scope ships, should `SessionStart` *nudge*
   the unscoped user to create one? Probably yes, once per project path,
   not every session.
3. **Sharing scope across machines.** A user with two Macs hits the same
   problem twice. v1 is local; sync is part of the wider artifacts-sync
   work — not in this spec.
4. **An explicit `.stm` project file.** A committable per-project
   `subscribetome.toml` listing scope, so the scope travels with the
   project on the user's other machines. Attractive, but it introduces a
   file format and version surface. Hold until at least one user asks.

## 10. Definition of done

- The user can register a project from the dashboard, mark keys as
  in-scope, and a Claude Code session opened in that path receives only
  those keys in its `SessionStart` guidance.
- The dashboard header tells the user which project the current session
  maps to (or that no project matches).
- `stm project list` and `stm project show <path>` work from the CLI.
- Opening Claude Code in an unrelated directory still works exactly as
  today — no regression for users who never opt in.
