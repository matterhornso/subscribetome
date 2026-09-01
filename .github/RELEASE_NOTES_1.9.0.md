Rotation, one-shot Codex setup, and a fail-open fix in the hook runtime.

## Security fix — please read if you installed bun with Homebrew

STM's shell entrypoints resolved the `bun` runtime with a lookup that knew only
the official-installer location. Homebrew's `/opt/homebrew/bin/bun` — the path
our own README recommends — was not covered, and the fallback was never checked
for executability.

Hooks are spawned by the agent host, whose PATH is frequently not your
interactive shell's (a GUI/Dock launch, some IDE hosts). When the lookup missed,
the **UserPromptSubmit paste guard exited without scanning**: a key pasted into
chat was not blocked, and nothing said the guard wasn't running.

If you installed bun via Homebrew and launch your agent from the GUI, treat that
guard as having been inactive. Run `stm doctor` — it now reports which `bun` the
hooks will execute, and reports not-ok when the runtime can't be resolved.

All seven entrypoints now share `hooks/resolve-bun.sh`, which checks PATH plus
five known install locations for an *executable* bun and, on a genuine miss,
states plainly that stm is not running and the guard is not scanning.

## Added

- **Provider-side key rotation (OpenAI).** `stm rotate openai <label> --provider`
  mints a fresh key through OpenAI's Admin API, repoints the same placeholder,
  and retires the old key at the source. Rotation is two-phase (mint → store →
  retire) so a failure can never leave your placeholder pointing at a deleted
  key; the old key is matched by last-4 and never guess-deleted when the match
  is ambiguous. `--dry-run` rehearses the whole thing read-only first.
  Audited as `rotate.issued` / `rotate.failed`. The manual paste-on-stdin flow
  is unchanged and remains the path for other providers.
- **One-shot Codex setup: `stm codex install`** — runs the hooks and MCP
  installers in a single idempotent command, with a copy-paste Codex install
  prompt in the README mirroring the Claude Code one.
- **`/stm:teams`** — walks an agent through `stm teams quickstart` end to end.
  The one human step (relaying a fingerprint over a trusted channel) is kept
  deliberately: it is the anti-MITM guarantee, not missing automation.
- **`stm doctor` agent-runtime section** — shows which `bun` the hooks execute.
- **`DESIGN.md`** — the landing page's design system.

## Fixed

- `stm codex install-hooks` no longer emits a duplicate `[features]` TOML table,
  which previously produced an invalid `~/.codex/config.toml` and broke the
  entire Codex config for anyone whose config already had that table.
- `stm policy add` rejects unrecognized flags instead of silently ignoring them
  and widening the rule to match everything.

## Notes

Provider-side rotation is built against OpenAI's documented Admin API with
offline tests; it has not yet been exercised against the live API. Run
`stm rotate openai default --provider --dry-run` first — it exercises auth and
both read endpoints without minting or deleting anything. See
`FIELD_VERIFICATION.md` §8 for the full checklist.

Full detail in [CHANGELOG.md](./CHANGELOG.md).
