#!/usr/bin/env bash
# subscribetome PreToolUse hook — placeholder injection + leak guards.
# Thin wrapper; all logic is in src/hooks.ts (preToolUse).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/hooks/resolve-bun.sh"
if ! stm_resolve_bun; then
  stm_bun_missing "PreToolUse hook"
  exit 0
fi
exec "$BUN" "$ROOT/src/cli.ts" hook pretooluse
