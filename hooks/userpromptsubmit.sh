#!/usr/bin/env bash
# subscribetome UserPromptSubmit hook — blocks a raw key pasted into the chat.
# Thin wrapper; all logic is in src/hooks.ts (userPromptSubmit).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/hooks/resolve-bun.sh"
if ! stm_resolve_bun; then
  stm_bun_missing "UserPromptSubmit hook"
  exit 0
fi
exec "$BUN" "$ROOT/src/cli.ts" hook userpromptsubmit
