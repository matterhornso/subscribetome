#!/usr/bin/env bash
# Shared bun resolution for every stm shell entrypoint.
#
# WHY THIS EXISTS: hooks are spawned by the agent host (Claude Code / Codex),
# whose environment is NOT the user's interactive shell. A GUI/Dock launch or
# an IDE host commonly has a minimal PATH with no Homebrew on it. The old
# one-liner
#
#     BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
#
# had two defects: it only knew the official-installer location (missing
# Homebrew's /opt/homebrew/bin/bun — which README.md itself recommends), and
# it never checked that the fallback was executable, so a miss produced a
# cryptic `exec: ... cannot execute` instead of a usable message.
#
# The failure was not cosmetic. With bun unresolvable the UserPromptSubmit
# paste guard exited 0 without scanning — a security control silently failing
# OPEN, with the user still believing pasted keys were being blocked.
#
# Mirrors resolveBunPath() in src/agents/codex-mcp-install.ts, which already
# solved this for the Codex MCP surface.

# Sets $BUN to an executable bun. Returns 0 on success, 1 if none found.
stm_resolve_bun() {
  local candidate
  # 1. PATH first — covers the normal case and any custom install.
  candidate="$(command -v bun 2>/dev/null || true)"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    BUN="$candidate"
    return 0
  fi
  # 2. Known install locations, most likely first. Each is checked for
  #    executability, so a stale/partial install falls through instead of
  #    becoming an exec failure.
  for candidate in \
    "$HOME/.bun/bin/bun" \
    "/opt/homebrew/bin/bun" \
    "/usr/local/bin/bun" \
    "/home/linuxbrew/.linuxbrew/bin/bun" \
    "/snap/bin/bun"
  do
    if [ -x "$candidate" ]; then
      BUN="$candidate"
      return 0
    fi
  done
  return 1
}

# Loud, actionable message when bun can't be found. $1 = hook/entrypoint name.
# Never silent: a guard that cannot run must say so rather than let the user
# assume they are protected.
stm_bun_missing() {
  local who="${1:-stm}"
  cat >&2 <<'EOF'
[stm] Cannot find the `bun` runtime — stm is NOT running.
EOF
  echo "[stm]   (entrypoint: ${who})" >&2
  cat >&2 <<'EOF'
[stm] Looked on PATH and in: ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin,
[stm]   /home/linuxbrew/.linuxbrew/bin, /snap/bin
[stm] Install bun (https://bun.sh) or, if it is already installed somewhere
[stm]   else, symlink it into one of those locations.
[stm] Until then: placeholders are NOT substituted and the paste guard does
[stm]   NOT scan your prompts. Run `stm doctor` for the full picture.
EOF
}
