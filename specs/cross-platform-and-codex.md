# Spec — Cross-platform (Linux, Windows) and Codex support

**Status:** Workstream A (Linux Secret Service) shipped v0.3.1 · Workstream C Option 1 (Codex session-env mode) shipped v0.4.0 · Workstream C guardrail port shipped v0.4.1 · Workstream B (Windows Credential Manager) shipped v0.5.0 · **Workstream A tiers 2 + 3 (LinuxPass + EncryptedFile) shipped v0.6.0** · C-Option-2 (MCP-wrapped Codex) pending · **Target:** subscribetome v2 · **Last updated:** 2026-05-25

This spec covers expanding subscribetome beyond its v1 footprint (macOS +
Claude Code) to **Linux**, **Windows**, and the **OpenAI Codex CLI**. It is a
planning document — no code yet. It records the research that shaped it so the
decisions can be re-examined.

---

## 1. Goal

Let a developer on any of the three major desktop OSes, using either Claude
Code or Codex, store API keys out of band and have the agent use them without
the key entering the chat — the v1 promise, on more platforms.

### Non-goals (for v2)

- Mobile, browser agents, or IDE-embedded assistants.
- A hosted/sync component. subscribetome stays local-only, no servers.
- Provider-side key rotation.
- Perfect parity of security guarantee across agents — see §5, Codex is weaker
  by necessity and that is stated to the user, not hidden.

---

## 2. Why v1 is macOS + Claude Code only — the two coupling points

subscribetome has exactly two platform-coupled pieces. Everything else
(`grammar.ts`, `detect.ts`, `store.ts`, `catalog.ts`, the dashboard, the CLI)
is portable as-is.

1. **Key storage** — `src/keychain.ts` shells out to the macOS `security` CLI.
   This is the OS coupling.
2. **Injection** — the real key is substituted into a command by Claude Code's
   `PreToolUse` hook returning `updatedInput`. This is the agent coupling.

v2 = make (1) pluggable per OS, and make (2) pluggable per agent.

---

## 3. The core finding — Codex cannot do `updatedInput`

Codex CLI has a hook system that mirrors Claude Code's, including a `PreToolUse`
event. **But its docs state that `updatedInput` (and `continue:false`,
`permissionDecision:"ask"`, …) are "parsed but not supported yet, so they fail
open."** A `PreToolUse` hook that returns `updatedInput` is rejected with
`"PreToolUse hook returned unsupported updatedInput"` and Codex runs the
**original, unmodified command**.

Consequences:

- The v1 mechanism — placeholder in the command, hook swaps in the real key,
  transcript keeps the placeholder — **does not port to Codex.**
- Codex `PreToolUse` today can only *deny* a command or add context. It is a
  guardrail, not a rewriter.
- Rewrite support is an open, unprioritized request: **openai/codex#18491**.
  If it ships, the v1 model becomes a drop-in for Codex. Track that issue.

So Codex support is not a port. It is a **second, different injection model**,
described in §6.

---

## 4. Proposed architecture

Two new abstraction seams. Both are small because the coupling is already
isolated.

### 4.1 `KeyStore` backend (replaces the hard-coded `keychain.ts`)

`store.ts` already calls only `keychainSet/Get/Delete`. Turn `keychain.ts` into
a resolver that picks a backend at startup behind the same three-function
surface:

```
interface KeyStore {
  set(ref: string, value: string): void;
  get(ref: string): string | null;
  delete(ref: string): void;
  describe(): string;   // human label for the dashboard/CLI, e.g. "macOS Keychain"
}
```

Backends:

| Backend | OS | Mechanism |
|---|---|---|
| `MacKeychain` | macOS | `security` CLI (current v1 code) |
| `WindowsCredential` | Windows | Win32 `wincred` API |
| `LinuxSecretService` | Linux (desktop) | `libsecret` / `secret-tool` |
| `LinuxPass` | Linux (headless) | `pass` (GPG-backed) |
| `EncryptedFile` | any (last resort) | passphrase-derived key (Argon2id), `0600` file |

**Evaluate `Bun.secrets`** as a shortcut: it is a built-in Bun API that already
wraps Keychain (macOS), Credential Manager (Windows), and libsecret (Linux). It
could collapse three backends into one — but it is marked experimental and
inherits the Linux headless limitation, so it does not remove the need for the
fallback backends. Decision: prototype `Bun.secrets` for macOS+Windows+Linux-
desktop; keep the fallback chain custom.

The resolver detects the environment and picks the highest backend that works;
an `$STM_KEYSTORE` override forces one. The chosen backend's `describe()` is
shown in the dashboard and `stm status` so the user always knows where keys
live.

### 4.2 `AgentAdapter` — per-agent integration

There is no single clean interface here; each agent's integration is its own
module. v2 has two:

- **Claude Code adapter** — the current `hooks/` directory + `hooks.json`.
  Unchanged.
- **Codex adapter** — new. See §6.

The CLI/dashboard gain an "agent" notion only where it affects setup
instructions and the security label shown to the user.

---

## 5. Workstream A & B — Linux and Windows key storage

These are tractable engineering. They are the same task (a new `KeyStore`
backend) and do not touch the agent side.

### Windows — **shipped v0.5.0**

- Win32 `wincred` API: `CredWriteW` / `CredReadW` / `CredDeleteW`,
  `CRED_TYPE_GENERIC` — called directly via Bun FFI against
  advapi32.dll. (We did NOT use the `cmdkey` CLI — it cannot read a
  password back. We did NOT use `keytar` — archived 2026-03.) The
  secret bytes go into `CREDENTIALW.CredentialBlob` by pointer,
  never via argv or stdin. Strict posture improvement over macOS.
- Blob limit 2560 bytes — irrelevant for API keys.
- Per-user, DPAPI-encrypted. Namespace target names `subscribetome:<ref>`.
- **WSL:** WSL sees neither Windows Credential Manager nor a Linux keyring.
  Ship a tiny Windows credential-helper `.exe` the WSL build calls via
  `/mnt/c/...` (the Git Credential Manager pattern), or let WSL fall to the
  `EncryptedFile` backend. Phase WSL after the core Windows backend.

### Linux — **shipped v0.3.1 + v0.6.0 (all three tiers)**

- Desktop (Tier 1): `secret-tool` / `libsecret`. Present on GNOME
  desktop installs; needs explicit install on KDE/minimal/server.
  Shipped v0.3.1.
- Headless / SSH / container / WSL — **shipped v0.6.0** as the tiered
  chain the spec called for:
  1. `$STM_KEYSTORE` override (CI / explicit pin).
  2. `LinuxSecretService` when D-Bus + unlocked keyring detected.
  3. `LinuxPass` (`pass`, GPG) — works over SSH with a GPG agent.
  4. `EncryptedFile` — PBKDF2-SHA512 600k + AES-256-GCM, mode 0600.
     Opt-in via `STM_ALLOW_FILE_BACKEND=1` on first touch; file
     existence is the consent thereafter.
- `stm doctor` reports the live tier diagnosis. Active backend is
  always announced via `stm status`, the dashboard pill, and
  `describe()`. Visible degradation — the spec's gh-CLI invariant
  holds.

---

## 6. Workstream C — Codex support

**Status:** Option 1 (session-env mode) **shipped v0.4.0**.
Guardrail port (UserPromptSubmit + SessionStart on Codex) **shipped
v0.4.1**. Option 2 (MCP-wrapped) and the future "per-command rewrite
if openai/codex#18491 lands" are still ahead.

Codex is the architectural decision, not a port. Per §3, per-command
transcript-clean rewrite is blocked. Two viable models:

### Option 1 — Environment injection (baseline, recommended to ship first)

Codex's `[shell_environment_policy]` injects env vars into every shell
subprocess. `set` (an explicit name→value map) bypasses Codex's default
`KEY/SECRET/TOKEN` scrubbing.

Flow: `subscribetome` wraps the `codex` launch, resolves the real keys from the
`KeyStore`, and supplies them via the environment Codex inherits (or a
generated `shell_environment_policy.set`). The agent's shell commands then read
them as normal env vars.

- ✅ Real key never appears in the chat. No new agent feature needed; ships now.
- ❌ **Security downgrade vs. Claude Code.** The key sits in the agent's process
  environment for the whole session, not substituted per-command. A command
  that dumps its environment can surface it. This is weaker and **must be
  stated to the user** — the dashboard/CLI shows "Codex: session-env mode"
  with the honest caveat.

### Option 2 — MCP-wrapped tools (higher assurance, later)

Codex fully supports MCP servers, including an `env` table for secrets. Instead
of the agent running raw `curl ... Bearer <key>`, expose an MCP tool (e.g.
`call_api`) that subscribetome runs; the MCP server reads the key from the
`KeyStore` at startup. The agent invokes a named tool and never handles the
secret.

- ✅ Closest structural equivalent to v1 — the agent never sees or types a key.
- ❌ Changes the UX (named tool calls, not arbitrary shell) and needs
  per-integration MCP wrappers. Bigger build.

### Recommendation

Ship **Option 1** first as "Codex support (session-env mode)", clearly labelled
as the weaker guarantee. Build **Option 2** as an opt-in higher-assurance mode.
If **openai/codex#18491** lands `updatedInput`, add a third adapter that is a
near-drop-in of the Claude Code hook and becomes the default for Codex.

The `UserPromptSubmit` and `SessionStart` hooks **do** port to Codex (same
events, `additionalContext` supported) — the guardrail that blocks a pasted key
and the self-teaching guidance work on Codex unchanged.

---

## 7. Open questions / risks

1. **Codex security framing.** Are we comfortable shipping a mode with a weaker
   guarantee under the same product name? Proposed answer: yes, if it is
   labelled honestly everywhere. Needs a product decision.
2. **`Bun.secrets` maturity.** Experimental. If it regresses we own the
   fallback anyway — low risk, but prototype before committing.
3. **Linux headless UX.** The `EncryptedFile` passphrase: prompt interactively?
   Read from an agent/env? This is the fiddliest UX in the spec.
4. **Codex hook coverage gaps** (openai/codex#20204): even the guardrail hooks
   only fire for "simple" shell calls; `unified_exec` can bypass them. The
   guardrail is best-effort on Codex — document it.
5. **WSL routing.** Treat WSL as its own case, not "Linux" — it should reach
   Windows Credential Manager via interop, or fall to `EncryptedFile`.

---

## 8. Suggested phasing

Ordered by value-to-effort. Each phase ships independently.

- **Phase 1 — `KeyStore` abstraction + Windows.** Refactor `keychain.ts` into
  the backend resolver; add `WindowsCredential`. Doubles OS reach; low risk.
- **Phase 2 — Linux desktop.** `LinuxSecretService`. Straightforward once the
  abstraction exists.
- **Phase 3 — Linux headless chain.** `LinuxPass` + `EncryptedFile` +
  detection + visible degradation. The deliberate, hard part.
- **Phase 4 — Codex, session-env mode + guardrails.** Launcher
  **shipped v0.4.0**; guardrail port (`UserPromptSubmit` +
  `SessionStart` on Codex) **shipped v0.4.1**. The hook code in
  `src/hooks.ts` is unchanged — Codex's stdin payload exposes
  `prompt`, `cwd`, and `hook_event_name` with snake_case keys, and
  accepts the camelCase `hookSpecificOutput` + `additionalContext`
  reply shape that Claude Code uses. The exit-code-2 + stderr
  block convention is identical. Configuration is the only thing
  that changed: `stm codex install-hooks` writes a
  marker-delimited block to `~/.codex/config.toml` using Codex's
  array-of-tables hook schema. **Trust gate**: Codex requires the
  user to approve each hook on first launch — surfaced in the
  install message, the doctor output, and the launch banner.
- **Phase 5 — Codex, MCP-wrapped mode.** Option 2, opt-in.
- **Watch:** openai/codex#18491. If `updatedInput` ships, insert a phase for
  the drop-in Codex hook adapter.

Phases 1-3 have no dependency on 4-5; OS work and agent work can run in
parallel. The user can reprioritize — e.g. Codex first if reach matters more
than the headless Linux story.

---

## 9. Definition of done (per platform)

- A key added via the dashboard is stored in that platform's backend and
  resolved back correctly; `stm status` names the active backend.
- The full test suite passes on the platform (the suite already parameterizes
  the keychain service via `$STM_KEYCHAIN_SERVICE`).
- The agent uses an injected key end to end, and the README states the exact
  guarantee for that OS+agent combination — including, for Codex session-env
  mode, the honest "weaker than Claude Code" caveat.
