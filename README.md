# subscribetome

**Your AI keys in the OS keychain. Claude Code uses them — without ever seeing them.**

The model writes `{{stm:openai:default}}`. The real key is swapped in at the moment the command runs. Keys never touch the chat.

## 1. Install

Paste this into Claude Code:

> Set up subscribetome for me using https://github.com/matterhornso/subscribetome

Quit and reopen Claude Code when it's done.

## 2. Add a key

```
/stm:dashboard
```

A local web page opens. Pick a service (OpenAI, Anthropic, Stripe, GitHub, …), paste the key. The key goes straight to your OS keychain — never through chat.

## 3. Use it

Just ask:

> Use my OpenAI key to call chat completions with the message "hello"

Claude Code sees a placeholder. The plugin swaps in the real key the instant the command runs.

That's it. macOS, Linux, Windows. Free. Open source. Zero telemetry.

---

**More:** [`DOCS.md`](./DOCS.md) — every command, the security model, the Codex surface · [`SECURITY.md`](./SECURITY.md) · [`CHANGELOG.md`](./CHANGELOG.md) · MIT licensed

<details>
<summary><b>Install instructions for the AI agent</b></summary>

Claude Code reads this when a user pastes the install prompt above. Humans can skip.

Do these steps in order. **Never ask the user for an API key. Never run a command that contains a real key. Never add a key yourself** — key entry is out-of-band by design.

1. **Check the OS.** Run `uname` (or `ver` on Windows). subscribetome supports macOS, Linux, and Windows.
2. **Check Bun.** Run `bun --version`. If that fails, install Bun with `curl -fsSL https://bun.sh/install | bash` (or `brew install bun` on macOS with Homebrew), then re-check.
3. **Add the marketplace:** `claude plugin marketplace add matterhornso/subscribetome`
4. **Install the plugin:** `claude plugin install stm@subscribetome`
5. **Tell the user**, in your own words: subscribetome is installed; they need to quit and reopen Claude Code to activate it; then run `/stm:dashboard` and add API keys in the web page that opens — the keys go straight to their OS keychain and the AI will never see them.
6. **Stop here.** Do not add keys. Do not ask the user to paste a key. Setup is complete.

</details>
