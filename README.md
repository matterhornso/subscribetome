# subscribetome

**AI API key & subscription manager — a Claude Code plugin.**

You use a dozen AI tools. Each issues API keys. They scatter across `.env`
files, dotfiles, password managers, and provider dashboards — and the monthly
bill creeps up on tools you forgot you were paying for. subscribetome is one
inventory of every AI tool, key, and subscription, and it lets a coding agent
*use* your keys without ever seeing them.

## How it works

Keys are entered **out-of-band** — never through the Claude Code chat — and
stored in your OS keychain. subscribetome only ever shows you a *placeholder*:

    {{stm:<tool>:<label>}}        e.g.  {{stm:openai:default}}

When the model writes a command that uses a placeholder, a `PreToolUse` hook
substitutes the real key at the last moment, via Claude Code's `updatedInput`.
The model sees the placeholder; the shell gets the real key.

```
you ──add key──▶ OS keychain          (out-of-band: dashboard form or import)

model writes:   curl -H "Authorization: Bearer {{stm:openai:default}}" ...
                       │
        PreToolUse hook │  substitutes the real key
                       ▼
shell runs:     curl -H "Authorization: Bearer sk-...real..." ...
```

Two guardrail hooks back it up:

- **UserPromptSubmit** blocks a prompt that contains a raw key — keys must
  never go through the chat.
- **PostToolUse** flags command output that leaked a key (a command that
  echoed or errored with its own input).

## Install

```
claude plugin install subscribetome --source github abhinavramesh/subscribetome
```

Requires [Bun](https://bun.sh). v1 stores keys in the **macOS Keychain**
(macOS only — see Limitations).

## Use

```
stm dashboard          open the localhost web UI (add keys, see inventory)
stm list               keys, subscriptions, monthly spend
stm import [dir]       scan .env files for keys to import
stm revoke <tool> <l>  mark a key revoked
stm status             daemon + inventory summary
stm stop               stop the dashboard daemon
```

Slash commands: `/subscribetome:dashboard`, `/subscribetome:inventory`,
`/subscribetome:import`, `/subscribetome:revoke`.

### Adding a key

Open the dashboard (`stm dashboard`) and use the **Add a key** form, or import
existing keys from `.env` files via the **Import** section. Either way the
value goes straight to your OS keychain. From then on you refer to the key only
by its placeholder.

### Using a key

Write the placeholder in any command:

```
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer {{stm:openai:default}}"
```

The `PreToolUse` hook substitutes the real key when the command runs. The
conversation only ever contains `{{stm:openai:default}}`.

## Placeholder grammar

`{{stm:<tool>:<label>}}` — `<tool>` and `<label>` are lowercase `[a-z0-9-]`,
1–64 characters each. The `(tool, label)` pair is the global address of a key;
labels need only be unique within a tool. Substitution is an **exact** match —
a malformed placeholder is never substituted; it is blocked with a did-you-mean
suggestion.

## Security model

- Key values live in the **OS keychain**, never in subscribetome's database and
  never in the Claude Code conversation.
- The `PreToolUse` hook substitutes a key only into **Bash** commands. A
  placeholder in a `Write`/`Edit` call is **blocked** — substituting it would
  persist a real key into a file.
- The dashboard daemon binds to `127.0.0.1`, requires a per-run auth token, and
  enforces a Host/Origin allowlist (DNS-rebinding defense).
- Hooks **fail safe**: on any internal error a hook exits without substituting,
  so a failure can never leak a key — at worst a command runs with an
  un-substituted placeholder and simply fails.

### What it cannot do

- **Output redaction is impossible.** A hook can only *block* a tool result
  that contains a key, not silently scrub it. PostToolUse flagging is reliable
  for keys subscribetome manages and best-effort for others.
- A command that prints its own arguments (`set -x`, verbose or error output)
  can still surface a substituted key in that command's output. PostToolUse
  *detects* this after the fact and tells you to rotate the key — it cannot
  prevent the leak.
- While a command with an injected key runs, the real key is an argument of
  that process — briefly visible to `ps` for other local processes. Injecting
  a secret into a shell command inherently requires this; subscribetome keeps
  the key out of the *conversation*, not out of the local process table.

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
bun test               run the test suite
bun src/cli.ts <args>  run the CLI from source
```

Runtime state lives in `~/.subscribetome/` (the SQLite inventory and the daemon
descriptor). Key values are in the OS keychain under the service name
`subscribetome`.

## License

MIT — see [`LICENSE`](./LICENSE).
