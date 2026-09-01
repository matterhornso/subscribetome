# Project State — subscribetome

_Snapshot taken 2026-09-01. A point-in-time orientation doc for picking the project back up (e.g. after re-cloning). For living docs see README.md, DOCS.md, CHANGELOG.md, TODOS.md._

## What this is

**subscribetome (`stm`)** — API-key security for AI coding agents. Real keys live in the OS keychain (or an AES-256-GCM vault on other tiers); the agent works through placeholders and never sees a value. Three surfaces share that invariant:

1. **Runtime hooks (Claude Code plugin).** The model writes `{{stm:openai:default}}` in a shell command; a **PreToolUse hook** swaps in the real key the instant the command runs. UserPromptSubmit blocks pasted secrets, PostToolUse flags leaked output, SessionStart teaches each session the workflow.
2. **The credential broker** (`src/broker.ts`, served by the daemon at `/proxy/<tool>/<label>/<path>`). A local egress proxy: the key is attached server-side on the outbound request to the provider's own origin, SSRF-guarded, and scrubbed from the response — it never enters argv, env, or output. Built-in targets: openai, anthropic, openrouter, groq, replicate, fal, stripe.
3. **STM Teams** (`src/teams/`). A self-hostable, zero-knowledge sync server: it stores only ciphertext, members enroll by public key with an out-of-band fingerprint check (deliberate anti-MITM step), usage reports are signed. Multi-team per machine; guided enrollment via `stm teams quickstart` and the `/stm:teams` slash command.

## Status as of this snapshot

- Branch `main`. **v1.9.0 is prepared but NOT yet tagged/published** — manifests, landing footer, and CHANGELOG all say 1.9.0; cutting the tag + GitHub release is a user-gated step (see the release checklist at the end of this file).
- Tests: **524 pass / 0 fail** across 42 files (`bun test`; use `STM_KEYCHAIN_SERVICE=subscribetome-test` and `ulimit -n 4096`). CI runs bun test (macOS + Linux) + Playwright UI (macOS).
- A full end-to-end QA pass (CLI sandbox sweep, live dashboard/broker leak + SSRF + auth-boundary checks, manifest/docs audit) came back clean on 2026-08-31.
- Codex support: two modes (session-env; MCP-wrapped via STM's own stdio MCP server) wired by `stm codex install`. Per-command rewrite parity is blocked upstream (openai/codex#18491).
- Working tree may carry an **intentionally uncommitted** MiniMax/GMI broker-provider change set (src/broker.ts, src/catalog.ts, catalog test bump, two minimax test files) — parked by explicit instruction, neither commit nor discard without asking.

## Repo layout

| Path | What's there |
|------|--------------|
| `src/` | Implementation: cli, daemon+dashboard, broker, store (SQLite), policy engine, catalog, grammar, hooks, import, doctor, sync, vault snapshot |
| `src/teams/` | Teams client, self-hosted server, keypair identity, signing |
| `src/agents/` | Codex adapters: env-injection launcher, hooks installer, MCP installer + stdio MCP server |
| `src/keystores/` | Keychain tiers: macOS FFI, Windows Credential Manager, Linux Secret Service / pass / encrypted file |
| `src/providers/` | Spend-sync providers (OpenAI, Anthropic) |
| `hooks/` | Claude Code hook scripts (pretooluse/posttooluse/userpromptsubmit/sessionstart) + `hooks/codex/` |
| `commands/` | Slash commands: `/stm:dashboard`, `/stm:import`, `/stm:inventory`, `/stm:revoke`, `/stm:teams` |
| `bin/stm` | CLI launcher (bash → `bun src/cli.ts`) |
| `test/`, `tests-ui/` | bun test suite; Playwright UI suite |
| `specs/` | Design docs (take precedence over TODOS.md) |
| `docs/` | Marketing site (GitHub Pages, custom domain per CNAME) |
| `DESIGN.md` | Landing-page design system (tokens, typography, don'ts) |
| `.claude-plugin/` | Plugin + marketplace manifests |
| `SECURITY.md`, `FIELD_VERIFICATION.md`, `TEST_PLAN.md` | Threat model; real-hardware verification notes; test plan |

## Standing constraints (non-negotiable)

- Real key values exist only in the keychain or ciphertext — never in transcript, logs, SQLite, or team/audit/usage records. Never have the user paste a credential into chat; key entry is out-of-band (stdin, dashboard).
- QA/dogfooding runs in a sandbox: point `STM_DB`, `STM_DAEMON_FILE`, `STM_KEYCHAIN_SERVICE` (and for Teams, `STM_TEAM_CONFIG`) at throwaway paths.
- Publishing GitHub releases is user-gated: prep everything, then hand over the command or wait for an explicit go.

## Release checklist (v1.9.0 — prepared, awaiting your go)

Everything below the line is already done and pushed. The remaining steps are
user-gated on purpose: publishing a release is outward-facing and irreversible.

Done:
- [x] `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` → `1.9.0`
- [x] `docs/index.html` footer + JSON-LD `softwareVersion` + `dateModified`
- [x] `CHANGELOG.md` `[1.9.0]` section written (Added / Changed / Fixed)
- [x] Full suite green (524 pass / 0 fail), CI green on `main`
- [x] Adversarial security review of the v1.8.0..HEAD diff: **no key leak**; four hardening findings fixed
- [x] `stm --version` reports `1.9.0`

Remaining (run these yourself):

```bash
git tag -a v1.9.0 -m "v1.9.0 — rotation, one-shot Codex setup, hook fail-open fix"
git push origin v1.9.0
gh release create v1.9.0 --title "v1.9.0" --notes-file .github/RELEASE_NOTES_1.9.0.md
```

Note on the release notes: the headline item is a **security fix** (the paste
guard could fail open when `bun` wasn't resolvable). Users who installed bun
via Homebrew and launch their agent from the GUI may have had that guard
silently not running. That is worth saying plainly in the announcement rather
than burying under the feature list.

## Picking it back up after deleting the folder

1. Re-clone to the **same path** so retained Claude memory reattaches:
   `git clone https://github.com/matterhornso/subscribetome.git /Users/abhinavramesh/subscribetome`
2. **Not restored by clone** (git-ignored, local-only): `.claude/`, `.gstack/`, `.DS_Store`.
3. Claude's persistent memory for this project lives **outside the repo** at
   `~/.claude/projects/-Users-abhinavramesh-subscribetome/memory/` — survives folder deletion, reattaches on same-path clone.
4. Open follow-ups: see `TODOS.md`. A browser extension is flagged "Coming soon" on the landing page.
