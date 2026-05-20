# subscribetome

**Use your AI API keys in [Claude Code](https://claude.com/claude-code) without the keys ever touching the chat.**

You have keys for a dozen AI tools, scattered across `.env` files and provider
dashboards. subscribetome puts them in one place and lets Claude Code *use* them
without ever seeing them. The model only sees a placeholder like
`{{stm:openai:default}}`; the real key is swapped in at the moment a command
runs.

![The subscribetome dashboard — add a key out-of-band, see your key inventory, track subscription spend](docs/screenshots/dashboard.png)

---

## Set it up for me

**New to this? You don't have to run anything yourself.** Paste this to Claude
Code:

> Set up subscribetome for me using https://github.com/matterhornso/subscribetome

Claude Code will read the instructions below and do the whole install. You do
exactly one thing by hand afterward: add your keys (Step 3 of "Use it"). That
part is deliberate — keys must never go through the chat.

<details>
<summary><b>Instructions for the AI agent</b> (Claude Code reads this — humans can skip)</summary>

Do these steps in order. **Never ask the user for an API key. Never run a
command that contains a real key. Never add a key yourself** — key entry is
out-of-band by design.

1. **Check the OS.** Run `uname`. If it does not print `Darwin`, stop and tell
   the user: "subscribetome v1 is macOS-only." Do not continue.
2. **Check Bun.** Run `bun --version`. If that fails, install Bun with
   `curl -fsSL https://bun.sh/install | bash` (or `brew install bun` if
   Homebrew is present), then re-check.
3. **Add the marketplace:** `claude plugin marketplace add matterhornso/subscribetome`
4. **Install the plugin:** `claude plugin install stm@subscribetome`
5. **Tell the user, in plain words:** "subscribetome is installed. Quit and
   reopen Claude Code to activate it. Then run `/stm:dashboard`,
   and add your API keys in the web page that opens — they go straight to your
   macOS Keychain, and I will never see them."
6. **Stop here.** Do not add keys. Do not ask the user to paste a key. Setup
   is complete once the user has been told to restart.

</details>

## Or install it yourself

**Needs:** macOS, [Claude Code](https://claude.com/claude-code), and
[Bun](https://bun.sh).

```
claude plugin marketplace add matterhornso/subscribetome
claude plugin install stm@subscribetome
```

Then quit and reopen Claude Code to activate it.

## Use it

1. Run the slash command `/stm:dashboard`. A web page opens on
   localhost.
2. Pick your service (Supabase, Twitter, Stripe, …) and the form shows its
   standard credential fields — or choose **Other** for anything custom. Fill
   the fields you have; each value goes straight to your macOS Keychain, never
   the chat. Need a credential the catalog doesn't list? **+ Add another field**
   stores it under your own label. You get back a placeholder for each, e.g.
   `{{stm:openai:default}}` or `{{stm:supabase:service-role-key}}`.
3. Write that placeholder in any command (an `Authorization: Bearer` header, an
   env var, anything). When the command runs, the real key is swapped in. The
   conversation only ever holds the placeholder.

That is the whole loop.

**You don't even need to know the placeholder syntax.** Once installed, every
Claude Code session automatically knows your keys live in stm. Just say what
you want in plain language — *"use my fal.ai key to make a short video"* — and
Claude looks up the placeholder itself and wires it into the command. Nothing
to configure: the plugin teaches each new session on its own.

---

## How it works

The model only ever sees placeholders. The real key lives in the macOS Keychain
and is materialized only inside a `PreToolUse` hook that rewrites a command the
instant before it runs:

```
model writes:   curl -H "Authorization: Bearer {{stm:openai:default}}" ...
                       |
        PreToolUse hook |  substitutes the real key
                       v
shell runs:     curl -H "Authorization: Bearer sk-...real..." ...
```

Two guardrail hooks back it up:

- **UserPromptSubmit** blocks a prompt that contains a raw key — or any secret
  stm already manages, including a plain password with no key shape. Secrets
  must never go through the chat.
- **PostToolUse** flags command output that leaked a key (a command that echoed
  or errored with its own input) and tells you to rotate it.

A fourth hook, **SessionStart**, teaches every new session how to use stm — so
Claude knows to look keys up and use placeholders with no per-project setup.

## Commands

Slash commands (after installing the plugin):

| Command | Does |
|---|---|
| `/stm:dashboard` | open the localhost dashboard |
| `/stm:inventory` | list keys, subscriptions, monthly spend |
| `/stm:import` | scan `.env` files for keys to import |
| `/stm:revoke` | mark a key revoked |

The `stm` CLI (on `PATH` once installed):

```
stm dashboard          open the localhost web UI
stm list               keys, subscriptions, monthly spend
stm import [dir]       scan .env files for keys to import
stm revoke <tool> <l>  mark a key revoked
stm status             daemon + inventory summary
stm stop               stop the dashboard daemon
```

## Placeholder grammar

A placeholder is `{{` `stm` `:` `<tool>` `:` `<label>` `}}` written with no
spaces. `<tool>` and `<label>` are lowercase `[a-z0-9-]`, 1-64 characters each.
The `(tool, label)` pair is the global address of a key. Substitution is an
**exact** match — a malformed placeholder is never substituted; it is blocked
with a did-you-mean suggestion.

## Security model

- Key values live in the **macOS Keychain**, never in subscribetome's database
  and never in the Claude Code conversation.
- The `PreToolUse` hook substitutes a key only into **Bash** commands — never
  into a file. A placeholder written to a file is just the harmless token; what
  the hook blocks in a `Write`/`Edit` is a **raw key** about to be persisted to
  a file.
- The dashboard daemon binds to `127.0.0.1`, requires a per-run auth token, and
  enforces a Host/Origin allowlist (DNS-rebinding defense).
- Hooks **fail safe**: on any internal error a hook exits without substituting,
  so a failure can never leak a key — at worst a command runs with an
  un-substituted placeholder and simply fails.

### What it cannot do

- **Output redaction is impossible.** A hook can only *block* a tool result that
  contains a key, not silently scrub it. PostToolUse flagging is reliable for
  keys subscribetome manages and best-effort for others.
- A command that prints its own arguments (`set -x`, verbose or error output)
  can still surface a substituted key in that command's output. PostToolUse
  *detects* this after the fact and tells you to rotate the key — it cannot
  prevent the leak.
- While a command with an injected key runs, the real key is an argument of
  that process — briefly visible to `ps` for other local processes. Injecting
  a secret into a shell command inherently requires this; subscribetome keeps
  the key out of the *conversation*, not out of the local process table.

## Compatibility

subscribetome v1 is a **Claude Code plugin** — the key-injection mechanism is a
Claude Code `PreToolUse` hook. The `stm` CLI and dashboard run standalone on any
macOS machine as a key inventory, but *automatic injection* requires Claude
Code. Support for other agentic coding tools (Codex, opencode, ...) depends on
each exposing an equivalent pre-execution input-rewrite hook — see `TODOS.md`.

## Limitations (v1)

- **macOS only** — keys are stored in the macOS Keychain via `security(1)`.
  Linux/Windows backends are deferred.
- **Import is `.env`-only** — scanning the broader OS keychain for arbitrary
  third-party keys is deferred (it is intrusive and noisy).
- `revoke` is a **metadata flag** — it does not call a provider API to rotate
  the key.

See [`TODOS.md`](./TODOS.md) for the deferred v1.5 scope.

## Development

```
git clone https://github.com/matterhornso/subscribetome
cd subscribetome
bun test               run the test suite
bun src/cli.ts <args>  run the CLI from source
```

Runtime state lives in `~/.subscribetome/` (the SQLite inventory and the daemon
descriptor). Key values are in the macOS Keychain under the service name
`subscribetome`.

## Project

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to send a change, and how to add
  a service to the catalog (a one-line, data-only contribution).
- [`SECURITY.md`](./SECURITY.md) — the threat model and how to report a
  vulnerability privately.
- [`CHANGELOG.md`](./CHANGELOG.md) — release history.
- [`TODOS.md`](./TODOS.md) — the deferred v1.5 scope.
- [`specs/cross-platform-and-codex.md`](./specs/cross-platform-and-codex.md) —
  v2 plan: Linux, Windows, and OpenAI Codex support.
- [`specs/spend-visibility.md`](./specs/spend-visibility.md) — the second
  product: real spend pulled from provider APIs, on demand only.
- [`specs/session-and-project-scope.md`](./specs/session-and-project-scope.md) —
  per-project key scope so multi-session, multi-project users see only the
  keys each session needs.

## License

MIT — see [`LICENSE`](./LICENSE).
