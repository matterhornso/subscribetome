#!/usr/bin/env bash
# subscribetome UserPromptSubmit hook for the OpenAI Codex CLI.
#
# Codex's hook system mirrors Claude Code's on the points stm relies on:
#   - stdin carries `prompt` + `cwd`           (per Codex hooks docs)
#   - exit code 2 + stderr blocks the prompt   (same as Claude Code)
#   - stdin keys are snake_case, but the two we read are spelled the same
#
# So this wrapper is identical to hooks/userpromptsubmit.sh — the hook
# logic in src/hooks.ts works on Codex unchanged. The two scripts are
# kept as separate files so Codex's config can reference an absolute
# path under hooks/codex/ (`stm codex install-hooks` writes it).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
exec "$BUN" "$ROOT/src/cli.ts" hook userpromptsubmit
