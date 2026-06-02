# Project State — subscribetome

_Snapshot taken 2026-06-02. A point-in-time orientation doc for picking the project back up (e.g. after re-cloning). For living docs see README.md, DOCS.md, CHANGELOG.md, TODOS.md._

## What this is

**subscribetome (`stm`)** — keeps your AI API keys in the OS keychain so Claude Code can *use* them without ever *seeing* them.

The mechanism: the model writes a placeholder like `{{stm:openai:default}}` inline in a shell command. A **PreToolUse hook** swaps in the real key at the moment the command runs. Keys never touch the chat transcript. Distributed as a Claude Code plugin.

## Status as of this snapshot

- Branch `main`, fully pushed and in sync with `origin/main` at commit `b608702`.
- CI: GitHub Actions runs `bun test` (macOS + Linux) + Playwright UI suite (macOS). Latest UI run: 18/18 passed.
- Phase: pre/soft-launch. Recent work has been **docs, landing page, and marketing** polish rather than core feature changes.
- Core key-substitution mechanism is verified working (see memory note "PreToolUse spike verified").

## Repo layout

| Path | What's there |
|------|--------------|
| `src/` | Implementation |
| `hooks/` | PreToolUse hook (the load-bearing key-substitution mechanism) |
| `commands/` | Slash commands (`/stm:dashboard`, `/stm:import`, `/stm:inventory`, `/stm:revoke`) |
| `bin/` | CLI entry (`stm list`, etc.) |
| `test/` | bun test suite |
| `tests-ui/` | Playwright UI tests |
| `specs/` | Specs |
| `docs/`, `DOCS.md`, `README.md` | Product + user docs, screenshots |
| `marketing/` | SEO playbook, soft-launch blog, marketing assets |
| `.claude-plugin/` | Plugin manifest |
| `FIELD_VERIFICATION.md` | Verification notes for the key-substitution mechanism |
| `CHANGELOG.md`, `TODOS.md` | History + open work |

## Recent commits

```
b608702 docs: soft-launch blog, SEO playbook + field verification updates
59dab22 docs: landing page — "Coming soon" callout for browser extension
2f7638a ci: opt Linux runner into the encrypted-file keystore tier
51be6df ci: GitHub Actions workflow — bun test (macOS + Linux) + Playwright UI (macOS)
376f681 test(ui): full Playwright UI suite — 18 / 18 passed
```

## Picking it back up after deleting the folder

1. Re-clone to the **same path** so retained Claude memory reattaches:
   `git clone https://github.com/matterhornso/subscribetome.git /Users/abhinavramesh/subscribetome`
2. **Not restored by clone** (git-ignored, local-only): `.claude/`, `.gstack/`, `.DS_Store`. These are tooling/config state, not project content.
3. Claude's persistent memory for this project lives **outside the repo** at
   `~/.claude/projects/-Users-abhinavramesh-subscribetome/memory/` — survives folder deletion, reattaches on same-path clone.
4. Open follow-ups: see `TODOS.md`. A browser extension is flagged "Coming soon" on the landing page.
