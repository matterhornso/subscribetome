# subscribetome

[![test](https://github.com/matterhornso/subscribetome/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/matterhornso/subscribetome/actions/workflows/test.yml)

**Your API keys in the OS keychain. Your AI coding agent uses them — without ever seeing them.**

The model writes `{{stm:openai:default}}`. The real key is swapped in at the moment the command runs. Keys never touch the chat, the transcript, or your logs — they live only in your OS keychain (or, on other platforms, an AES-256-GCM vault).

![subscribetome dashboard — add a key, see your inventory, fetch live spend](docs/screenshots/dashboard.png)

`stm` starts as a personal key manager and grows with you: a **credential broker** so an agent can call HTTP APIs with a key it never sees, and **STM Teams** — a self-hostable, zero-knowledge server for sharing credentials and attributing usage across a team. Everything is free, open source, local-first, and zero-telemetry.

## 1. Install

**Claude Code** — paste this in:

> Set up subscribetome for me using https://github.com/matterhornso/subscribetome

Quit and reopen Claude Code when it's done.

**Codex** — paste this in:

> Set up subscribetome for Codex using https://github.com/matterhornso/subscribetome

Codex will prompt you to trust the new hooks the first time it restarts — press y.

## 2. Add a key

```
/stm:dashboard
```

A local web page opens. Pick a service (OpenAI, Anthropic, Stripe, GitHub, …), paste the key. The key goes straight to your OS keychain — never through chat.

## 3. Use it

Just ask:

> Use my OpenAI key to call chat completions with the message "hello"

Claude Code sees a placeholder. The plugin swaps in the real key the instant the command runs.

---

## The credential broker — for HTTP APIs

Substituting a key into a shell command works everywhere, but has a ceiling: for the moment the command runs, the key is a real argument (visible to `ps`, leakable if the command echoes its own arguments). For HTTP APIs, point the request at the local daemon instead:

```
curl http://127.0.0.1:<port>/proxy/openai/default/v1/models
```

`stm` resolves the credential from the keychain and attaches the real auth on the **outbound** call to the provider — the key never enters the command's argv, environment, or output. An SSRF guard keeps it on the target's own origin, the response is scrubbed of the key, and every brokered call is a first-class audit event.

```
stm broker              print the base URL + a loopback-only capability token
```

## STM Teams — share credentials, attribute usage

Run your own sync server (`stm teams serve`); it stores **only ciphertext it cannot decrypt**. Credentials are encrypted on a member's machine with a team key the server never sees. Members enroll by **public key** — no shared passphrase is ever passed around — and every usage report is **signed**, so the team log attributes "who used which key" to a cryptographically-verified member, never a self-asserted name.

In Claude Code, `/stm:teams` walks the agent through creating or joining a team end-to-end via `stm teams quickstart`. The whole flow is CLI-driven; the only human step is relaying one short fingerprint/member-id string over a channel you already trust — that's what stops a compromised server from swapping in a team key it controls.

```
stm teams init          create a team (admin)
stm teams join          join from a member machine
stm teams share <k>     mark a key shared with the team (keys are personal by default)
stm teams push / pull   sync the encrypted vault
stm teams usage         who used which key, cryptographically attributed
```

A machine can belong to several teams at once (`stm teams list` / `use <name>`), and the dashboard has a read-only **Teams** tab that shows members and the signed usage log.

![The dashboard's Teams tab — the teams this machine is in, members and enrollment, and the signed usage log: who used which key, cryptographically attributed, never a key value](docs/screenshots/teams.png)

---

## What it is

`stm` is API-key security for AI coding agents, keychain-first: the real value lives in the OS keychain and the agent works through placeholders. Four Claude Code hooks make it load-bearing — **PreToolUse** substitutes the key the instant before a command runs; **UserPromptSubmit** blocks a raw secret pasted into chat; **PostToolUse** flags output that leaked a key and tells you to rotate it; **SessionStart** teaches every new session the workflow with no per-project setup.

**This beta is scoped to macOS + Claude Code** — the runtime hooks that rewrite commands are strongest there. Linux and Windows are experimental (the Bash hook may not fire on native Windows), and Codex is experimental. The broker and the Teams server are plain Bun programs and run anywhere Bun does. Free. Open source. Zero telemetry.

---

**More:** [`DOCS.md`](./DOCS.md) — every command, the security model, the broker, Teams, and the Codex surface · [docs site](https://subscribetome.pro/docs.html) · [`SECURITY.md`](./SECURITY.md) — the threat model + how to report a vulnerability · [`CHANGELOG.md`](./CHANGELOG.md) · MIT licensed

**Contributing & community:** [`CONTRIBUTING.md`](./CONTRIBUTING.md) · [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) · found a security issue? see [`SECURITY.md`](./SECURITY.md) (please don't open a public issue)

<details>
<summary><b>Install instructions for the AI agent</b></summary>

Claude Code reads this when a user pastes the install prompt above. Humans can skip.

Do these steps in order. **Never ask the user for an API key. Never run a command that contains a real key. Never add a key yourself** — key entry is out-of-band by design.

1. **Check the OS.** Run `uname` (or `ver` on Windows). This beta is supported on **macOS**; Linux and Windows are experimental — on native Windows (no WSL/git-bash) the Bash hook may not fire, so tell a Windows user this is experimental before continuing.
2. **Check Bun.** Run `bun --version`. If that fails, install Bun with `curl -fsSL https://bun.sh/install | bash` (or `brew install bun` on macOS with Homebrew), then re-check.
3. **Add the marketplace:** `claude plugin marketplace add matterhornso/subscribetome`
4. **Install the plugin:** `claude plugin install stm@subscribetome`
5. **Tell the user**, in your own words: subscribetome is installed; they need to quit and reopen Claude Code to activate it; then run `/stm:dashboard` and add API keys in the web page that opens — the keys go straight to their OS keychain and the AI will never see them.
6. **Stop here.** Do not add keys. Do not ask the user to paste a key. Setup is complete.

</details>

<details>
<summary><b>Codex install instructions for the AI agent</b></summary>

Codex reads this when a user pastes the Codex install prompt above. Humans can skip.

Do these steps in order. **Never ask the user for an API key. Never run a command that contains a real key. Never add a key yourself** — key entry is out-of-band by design.

1. **Check the OS.** Run `uname` (or `ver` on Windows). Codex support is experimental — tell the user this before continuing.
2. **Check Bun.** Run `bun --version`. If that fails, install Bun with `curl -fsSL https://bun.sh/install | bash` (or `brew install bun` on macOS with Homebrew), then re-check.
3. **Clone the repo** somewhere stable (it stays on disk — this isn't a Claude Code plugin install): `git clone https://github.com/matterhornso/subscribetome.git ~/.subscribetome-src` (skip if it already exists; `git -C ~/.subscribetome-src pull` to update instead).
4. **Run the one-shot installer:** `~/.subscribetome-src/bin/stm codex install`. This wires up BOTH tracks in `~/.codex/config.toml` in one step: the UserPromptSubmit/SessionStart guardrail hooks, and the MCP server that lets Codex call HTTP APIs without the key ever entering its process (`stm_http_request`).
5. **Verify:** `~/.subscribetome-src/bin/stm codex doctor` — both tracks should report OK.
6. **Tell the user**, in your own words: subscribetome is installed for Codex; they need to restart Codex and press "y" when it asks to trust the new hooks; then run `~/.subscribetome-src/bin/stm dashboard` and add API keys in the web page that opens — the keys go straight to their OS keychain and the AI will never see them.
7. **Stop here.** Do not add keys. Do not ask the user to paste a key. Setup is complete.

</details>
