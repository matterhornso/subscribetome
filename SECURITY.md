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
- **Hook failure during substitution.** On any internal error the `PreToolUse`
  hook substitutes nothing and exits 0 — a substitution failure cannot put a
  key into a command, so it cannot leak one.

  Be precise about the limit of that guarantee: it covers the *substitution*
  path, not the *detection* paths. `UserPromptSubmit` and `PostToolUse` are
  scanners, and a scanner that cannot run does not block anything. If the
  hooks cannot start at all — for example the `bun` runtime is not resolvable
  in the environment the agent host spawns hooks in — then pasted keys are not
  blocked and leaked output is not flagged. That is a fail-open, and it is why
  a missing runtime is now loud (each entrypoint says stm is not running) and
  why `stm doctor` reports the runtime and returns not-ok when it is missing.
  See CHANGELOG 1.9.0; versions before 1.9.0 failed this silently.

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
- **The provider side (mostly).** `stm revoke` is a metadata flag: it marks the
  key unusable locally and does not call any provider API. Revoke at the
  provider too. The one exception is `stm rotate <tool> <label> --provider`,
  which does mint a replacement and retire the old key through the provider's
  own admin API — OpenAI only today, and only on that explicit user-initiated
  command.

## Data handling

subscribetome has **no servers and no backend of its own**, and **no
telemetry** — it never phones home. Every outbound call is deliberate and
user-initiated, and there are exactly three:

- `stm sync` (or **Fetch live spend**) calls the billing/usage API of **the
  providers you have configured** — today OpenAI and Anthropic — to pull your
  month-to-date spend, using an admin key you added. (See
  `specs/spend-visibility.md` §2 for the exact rule.)
- `stm rotate … --provider` calls the provider's key-management API to mint a
  replacement key and retire the old one (OpenAI only today).
- The **credential broker**, when you point a request at it, forwards that
  request to the provider you addressed — that is its entire purpose.

Nothing is sent in the background, on a schedule, or to us. If you run none of
the above, subscribetome makes zero outbound network calls. STM Teams is
self-hosted: if you run `stm teams serve`, that server is yours, and it stores
only ciphertext it cannot decrypt.

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
