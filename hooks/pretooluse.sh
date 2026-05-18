#!/usr/bin/env bash
# subscribetome PreToolUse hook — placeholder injection + leak guards.
# Thin wrapper; all logic is in src/hooks.ts (preToolUse).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
exec "$BUN" "$ROOT/src/cli.ts" hook pretooluse
