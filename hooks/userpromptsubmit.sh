#!/usr/bin/env bash
# subscribetome UserPromptSubmit hook — blocks a raw key pasted into the chat.
# Thin wrapper; all logic is in src/hooks.ts (userPromptSubmit).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
exec "$BUN" "$ROOT/src/cli.ts" hook userpromptsubmit
