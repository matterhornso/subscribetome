#!/usr/bin/env bash
# subscribetome PostToolUse hook — flags command output that leaked a key.
# Thin wrapper; all logic is in src/hooks.ts (postToolUse).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
exec "$BUN" "$ROOT/src/cli.ts" hook posttooluse
