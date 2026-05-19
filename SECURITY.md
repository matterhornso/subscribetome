# Security Policy

subscribetome handles API keys, so its security posture is the product. This
document states what it protects, what it does not, and how to report a flaw.

## Reporting a vulnerability

**Do not open a public issue for a security flaw.**

- Preferred: open a private [GitHub Security Advisory](https://github.com/matterhornso/subscribetome/security/advisories/new).
- Or email **abhinav@chainflux.com** with `subscribetome security` in the subject.

Please include the version (`stm --version` or the `plugin.json` version),
your OS, and steps to reproduce. Expect an acknowledgement within a few days.
This is a small open-source project, not a funded program — there is no bug
bounty, but credit is given in the advisory unless you ask otherwise.

## Threat model

subscribetome's one job: a real API key value must never enter the Claude Code
conversation transcript. Everything below serves that.

### What it protects against

- **Keys in the transcript.** The model only ever sees a `{{stm:<tool>:<label>}}`
  placeholder. The real value is substituted by the `PreToolUse` hook *after*
  the model's turn, into the command the Bash tool runs — the transcript keeps
  the placeholder.
- **A key pasted into chat.** `UserPromptSubmit` blocks a prompt containing a
  key (by shape) or any secret stm manages (by exact value).
- **A raw key written to a file.** `PreToolUse` blocks a key-shaped string in
  `Write`/`Edit` content.
- **Network exposure of the dashboard.** The daemon binds to `127.0.0.1`,
  requires a per-run token, and enforces a Host/Origin allowlist (DNS-rebinding
  defence).
- **Hook failure.** Hooks fail safe: on any internal error a hook substitutes
  nothing and exits 0. A failure can never leak a key.

### What it does NOT protect against — by design

- **A command that prints its own input.** `set -x`, verbose logging, or an
  error that echoes arguments can surface a substituted key in that command's
  output. `PostToolUse` *detects* this after the fact and tells you to rotate
  the key — it cannot prevent it. Output redaction is not possible from a hook.
- **The local process table.** While a command with an injected key runs, the
  key is an argv element of that process, briefly visible to a local `ps`.
  This is inherent to passing a secret to a shell command.
- **A compromised local machine.** Keys live in the macOS Keychain; anything
  that can read your Keychain (malware running as you, physical access to an
  unlocked machine) can read them. subscribetome is not a defence against that.
- **The provider side.** `stm revoke` is a metadata flag; it does not call a
  provider API to rotate the key. Revoke at the provider too.

## Data handling

subscribetome has **no servers and no backend**. Nothing is sent anywhere.

- Key values: macOS Keychain (service name `subscribetome`), OS-encrypted.
- Inventory metadata (tool/label/status/cost — never key values): a local
  SQLite file at `~/.subscribetome/db.sqlite`.
- The dashboard is a localhost-only page. There is no telemetry.

## Supported versions

Pre-1.0: only the latest published version is supported. Update with
`claude plugin update stm@subscribetome`.
