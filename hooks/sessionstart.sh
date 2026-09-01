#!/usr/bin/env bash
# subscribetome SessionStart hook — injects stm usage guidance into every
# session so the model knows how to use stm-managed keys with no user setup.
# Thin wrapper; all logic is in src/hooks.ts (sessionStart).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/hooks/resolve-bun.sh"
if ! stm_resolve_bun; then
  stm_bun_missing "SessionStart hook"
  exit 0
fi
exec "$BUN" "$ROOT/src/cli.ts" hook sessionstart
