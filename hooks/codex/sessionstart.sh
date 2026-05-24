#!/usr/bin/env bash
# subscribetome SessionStart hook for the OpenAI Codex CLI.
#
# Per Codex hooks docs (developers.openai.com/codex/hooks):
#   - stdin: snake_case payload with `cwd`, `session_id`, `source`, …
#   - stdout: camelCase `hookSpecificOutput` with `additionalContext`,
#     which Codex injects as developer context (same shape Claude Code
#     accepts — what src/hooks.ts already emits).
#   - plain stdout text is also injected as developer context, so the
#     hook is still useful even when JSON parsing of our reply is
#     loose on the Codex side.
#
# So this wrapper is identical to hooks/sessionstart.sh — the hook
# logic in src/hooks.ts works on Codex unchanged.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
exec "$BUN" "$ROOT/src/cli.ts" hook sessionstart
