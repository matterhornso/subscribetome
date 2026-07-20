# Security Policy

subscribetome handles API keys, so its security posture is the product. This
document states what it protects, what it does not, and how to report a flaw.

## Reporting a vulnerability

**Do not open a public issue for a security flaw.**

- Preferred: open a private [GitHub Security Advisory](https://github.com/matterhornso/subscribetome/security/advisories/new).
- Or email **abhinav@matterhorn.so** with `subscribetome security` in the subject.

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
- **A compromised local machine.** Keys live in your OS keychain (macOS
  Keychain, Linux Secret Service / `pass` / encrypted file, or Windows
  Credential Manager — run `stm doctor` to see which is active); anything that
  can read that store (malware running as you, physical access to an unlocked
  machine) can read them. subscribetome is not a defence against that.
- **The provider side.** `stm revoke` is a metadata flag; it does not call a
  provider API to rotate the key. Revoke at the provider too.

## Data handling

subscribetome has **no servers and no backend of its own**, and **no
telemetry** — it never phones home. The one exception is deliberate and
user-initiated: when you run `stm sync` (or click **Fetch live spend**), it
calls the billing/usage API of **the providers you have configured** — today
OpenAI and Anthropic — to pull your month-to-date spend, using an admin key
you added. Nothing is sent in the background, on a schedule, or to us. If you
never run sync, subscribetome makes zero outbound network calls. (See
`specs/spend-visibility.md` §2 for the exact rule.)

- Key values: your OS keychain (service name `subscribetome`), OS-encrypted —
  never in the database, never in the chat, never in argv logs.
- Inventory metadata (tool / label / status / cost / renewal date, and the
  funding **card nickname + last-4** — never a full card number, never a key
  value): a local SQLite file at `~/.subscribetome/db.sqlite`, mode `0600`.
  Card data is limited to the last four digits by design (PCI DSS v4 Req 3.5.1
  truncation); a full card number is rejected, not stored.
- The dashboard is a localhost-only page, bound to `127.0.0.1` behind a
  per-run auth token. There is no telemetry.

## Supported versions

During the beta, only the latest published version is supported. Update with
`claude plugin update stm@subscribetome`.
