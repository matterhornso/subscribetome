# Field verification

Five surfaces shipped in v0.4 – v0.7 were built on a macOS dev host
where the test suite uses injected fakes for the platform-specific
parts (Bun FFI bindings, JSON-RPC MCP framing, Codex hook plumbing,
passphrase TTY UX). Each one passes a synthetic smoke test on the
build host AND a thorough test matrix against the injected interface,
but the **integration with real hardware / real Codex / real
libsecret** has not been exercised on the build machine.

This doc is the checklist a community user with the right environment
can run through to confirm each surface works end-to-end. **If any
step fails, please file an issue** with the output of `stm doctor`
plus the exact command and error.

Last updated: **2026-05-25** (v0.7.1).

---

## Status legend

| Marker | Meaning |
|---|---|
| ✅ verified | Confirmed working on real hardware. |
| 🧪 smoke-tested | The build host ran a synthetic smoke test (JSON in / JSON out, or FFI round-trip). Real-host run pending. |
| ⏳ unverified | Built per the spec; needs a community report. |

## Surface matrix

| Surface | Built in | Status | Needs (real host) |
|---|---|---|---|
| macOS Keychain backend (Bun FFI) | v0.6.1 | ✅ verified | (this IS the dev host) |
| Linux Secret Service backend | v0.3.1 | ⏳ unverified | A GNOME / KDE desktop with `gnome-keyring-daemon` running |
| Linux Pass backend (Tier 2) | v0.6.0 | ⏳ unverified | A host with `pass` + GPG agent (SSH session works) |
| Linux EncryptedFile backend (Tier 3) | v0.6.0 | 🧪 smoke-tested | Any Linux host (incl. headless / WSL) |
| Windows Credential Manager backend | v0.5.0 | ⏳ unverified | Windows 10 / 11 with bun installed |
| Claude Code Hooks (PreToolUse + others) | v0.1+ | ✅ verified | (this IS the dev host) |
| Codex Option 1 — session-env launcher | v0.4.0 | 🧪 smoke-tested | Codex CLI installed + an OpenAI key |
| Codex hooks port (UserPromptSubmit + SessionStart) | v0.4.1 | 🧪 smoke-tested | Codex CLI + trust-prompt approval |
| Codex Option 2 — MCP-wrapped tools | v0.7.0 | 🧪 smoke-tested | Codex CLI + trust-prompt approval |

---

## 1. Linux Secret Service backend (v0.3.1)

The desktop tier. Should "just work" on any GNOME or KDE install
with `libsecret-tools` and an unlocked keyring daemon. **What
needs verifying is the headless-detection probe** — i.e. confirming
the resolver does NOT silently degrade on a host where Tier 1 is
broken.

### Steps

```bash
# 1. On a Linux desktop with gnome-keyring or kwallet running:
apt install libsecret-tools      # or: dnf install libsecret / pacman -S libsecret
stm status                       # expect: keystore : Linux Secret Service (libsecret)

# 2. Add and resolve a key end-to-end:
echo "test-value-XYZ" | stm add --tool myservice --label default
stm list                         # should show {{stm:myservice:default}}
stm resolve {{stm:myservice:default}}   # interactive TTY only — expect: test-value-XYZ
secret-tool search service subscribetome key '<the keychain_ref shown above>'
                                 # confirms the value actually lives in the SS daemon

# 3. Headless-detect: kill the keyring daemon (or SSH in with no D-Bus session)
unset DBUS_SESSION_BUS_ADDRESS
stm status
# EXPECTED: stm doctor reports Tier 1 unreachable, falls to Tier 2 (or
# unsupported if pass isn't installed). Should NEVER silently degrade
# to plaintext.
```

### Failure modes to file

- `stm status` shows "macOS Keychain" on a Linux host (resolver bug).
- `stm doctor` does NOT mention "secret-tool not found" or "no Secret
  Service reachable" when those are true.
- A `stm add` succeeds but the value can't be read back via `secret-tool`.

---

## 2. Linux Pass backend — Tier 2 (v0.6.0)

The headless tier. Verifies the `pass insert --multiline -f`
secret-via-stdin posture.

### Steps

```bash
# 1. Set up pass + GPG on a host where libsecret is NOT reachable
#    (or force it: `unset DBUS_SESSION_BUS_ADDRESS`).
apt install pass
gpg --quick-generate-key 'you@example.com' default default 1y
pass init 'you@example.com'

# 2. Verify the resolver picks Tier 2:
stm doctor
# EXPECTED: Tier 1 unreachable + Tier 2 active.
stm status
# EXPECTED: keystore : Linux Pass (pass + GPG)

# 3. Round-trip:
echo "tier2-secret" | stm add --tool t2 --label default
pass show subscribetome/<keychain_ref>   # confirm value at-rest
stm resolve {{stm:t2:default}}            # confirm read path

# 4. POSTURE CHECK: while a write is in flight, the secret must NOT
#    appear in `ps`. In one terminal:
strace -f -e trace=execve stm add --tool ps-check --label default <<< "ps-check-secret"
# In strace's output, look for an `execve` call to `pass`. Verify the
# `pass-check-secret` string does NOT appear in the argv array. (It
# should appear only in the stdin pipe, which strace doesn't capture
# by default — that's the point of the test.)
```

### Failure modes to file

- The secret string appears as an argv element in the `execve` trace.
- `pass ls` succeeds but `stm doctor` reports Tier 2 unreachable.
- `stm resolve` returns null for a value that `pass show` returns.

---

## 3. Linux EncryptedFile backend — Tier 3 (v0.6.0)

The opt-in last-resort tier. PBKDF2-SHA512 (600 000 iterations) +
AES-256-GCM. The crypto is exercised on the build host; what needs
verifying on a real headless box is the **passphrase UX** —
specifically that non-TTY hooks fail safe rather than blocking.

### Steps

```bash
# 1. In a fresh container or SSH session (no SS, no pass):
export STM_ALLOW_FILE_BACKEND=1
stm doctor          # Tier 1 + 2 unreachable; Tier 3 OK
stm status          # keystore : EncryptedFile (0600, PBKDF2-SHA512)

# 2. Interactive add. You'll be prompted for a passphrase the first
#    time you write. Pick something you can remember for this session.
echo "tier3-secret" | stm add --tool t3 --label default

# 3. Non-interactive read (the load-bearing fail-safe path).
#    This emulates how the Claude Code PreToolUse hook calls in:
echo '{"tool_name":"Bash","tool_input":{"command":"echo {{stm:t3:default}}"}}' \
  | stm hook pretooluse
# EXPECTED: exits 0 (no passphrase available + non-TTY = fail safe).
# Should NOT throw an error or leak the key to stdout.

# 4. Non-interactive read WITH the env var (the documented path):
echo '{"tool_name":"Bash","tool_input":{"command":"echo {{stm:t3:default}}"}}' \
  | STM_FILE_PASSPHRASE='<the passphrase>' stm hook pretooluse
# EXPECTED: stdout includes the rewritten command with tier3-secret
#           substituted. Confirms env-var passphrase works.

# 5. File at rest:
ls -la ~/.local/share/subscribetome/keys.enc
# EXPECTED: mode -rw------- (0600). NEVER world- or group-readable.
stm vault info
# EXPECTED: magic OK, mode OK, kdf id 1.

# 6. Rotate:
stm vault rotate-passphrase
# Provide old + new passphrase. Should leave a .bak.<ts> file.
ls ~/.local/share/subscribetome/keys.enc*
# EXPECTED: keys.enc + keys.enc.bak.<unix-ts>
```

### Failure modes to file

- Step 3 throws an error instead of exiting 0 — fail-safe contract
  broken. Hooks need to ALWAYS exit 0 on missing-passphrase, never
  block.
- `keys.enc` is created with mode != 0600.
- A wrong passphrase silently returns garbage instead of throwing
  "vault decryption failed" (would mean GCM tag isn't being checked).
- `stm vault rotate-passphrase` succeeds despite a wrong old passphrase
  (must abort BEFORE touching the file).

---

## 4. Windows Credential Manager backend (v0.5.0)

The bun:ffi binding to `advapi32.dll`'s `CredWriteW` /
`CredReadW` / `CredDeleteW`. The CREDENTIALW struct layout (80
bytes, documented public ABI stable since Windows 2000) is hand-
packed. **The most likely thing to fail in practice is the
bun:ffi pointer-read of the OS-allocated CREDENTIALW struct**
— that's exactly the part the injected tests cannot cover.

### Steps

```powershell
# 1. Install bun on Windows (https://bun.sh/) and put it on PATH.

# 2. Clone and run stm:
git clone https://github.com/matterhornso/subscribetome
cd subscribetome
bun src/cli.ts status
# EXPECTED: keystore : Windows Credential Manager (DPAPI)

# 3. Add a key and confirm it lands in Credential Manager:
echo "win-secret-XYZ" | bun src/cli.ts add --tool wintest --label default
# Open: Control Panel → Credential Manager → Windows Credentials.
# EXPECTED: entry under "Subscribetome:<some-uuid>" with type
# "Generic Credential".

# 4. Read it back:
bun src/cli.ts resolve "{{stm:wintest:default}}"
# EXPECTED: win-secret-XYZ

# 5. Delete:
bun src/cli.ts revoke wintest default
# (note: revoke is metadata; the Credential Manager entry persists
#  until you stm delete the key — that surface is dashboard-only
#  today)

# 6. Verify the FFI doesn't leak via argv. In an admin PowerShell:
Get-Process bun -ErrorAction SilentlyContinue | Select-Object CommandLine
# EXPECTED: while stm add is running, the secret value
# "win-secret-XYZ" does NOT appear in the command line. (The bytes
# go into CREDENTIALW.CredentialBlob via FFI pointer; argv carries
# only the service / account strings.)
```

### Failure modes to file

- `bun src/cli.ts status` reports "platform win32 is not yet supported"
  — means the FFI probe (`isWincredReachable`) returned false. File
  with the Win32 error code printed by `GetLastError`.
- `CredWriteW` returns false and `lastStatus()` is non-zero — file
  the OSStatus code; could be a sandbox / restricted-account issue.
- A read returns null when the Credential Manager UI shows the entry
  IS present — most likely a pointer-read bug in the CREDENTIALW
  walk. File with `stm doctor` + the entry visible in `cmdkey /list`.

---

## 5. Codex Option 1 — session-env launcher (v0.4.0)

`stm codex [args...]` resolves all active keys (or the project's
scoped subset), exposes each as `STM_<TOOL>_<LABEL>` env var via
the `shell_environment_policy.include_only=["STM_*"]` config
override, and spawns codex.

### Steps

```bash
# 1. Install Codex CLI (https://github.com/openai/codex).
# 2. Add an OpenAI key in stm:
stm dashboard
# (web UI: add openai:default with your real key)

# 3. Launch codex via the stm wrapper:
stm codex
# EXPECTED stderr banner: "stm codex — session-env mode (...)" listing
# STM_OPENAI_DEFAULT among the injected env vars.

# 4. Inside the codex session, ask it to print one env var name (not
#    value) to confirm visibility:
#   prompt: "echo 'env var name:' && echo $STM_OPENAI_DEFAULT | head -c 5; echo '...'"
# EXPECTED: the first 5 characters of your key (e.g. "sk-xx"), then
# "...". This proves the env var is reachable from the agent's shell
# — the spec's acceptance criterion.

# 5. Without stm codex (control): launch plain `codex` from a shell
# that does NOT have STM_OPENAI_DEFAULT set and confirm the env var
# is absent (so we know stm codex is the source).
```

### Failure modes to file

- The banner doesn't appear (means `process.stderr.write` was
  redirected by Codex). Acceptable but worth documenting.
- The env var is not visible in the agent's shell. Most likely cause:
  the `-c shell_environment_policy.include_only=["STM_*"]` override
  isn't being honored by the installed Codex version. File with
  `codex --version`.

---

## 6. Codex hooks port (v0.4.1)

The UserPromptSubmit + SessionStart guardrails registered via
`~/.codex/config.toml`. The hook code in `src/hooks.ts` works on
Codex unchanged per spec; the unverified part is **the trust gate**
— Codex prompts for approval on first launch, and until approval
the hook is silently skipped.

### Steps

```bash
# 1. Install the hooks:
stm codex install-hooks
# EXPECTED stdout: "Codex will prompt you to TRUST each hook the first
# time it starts — until you approve, the hook is silently skipped."

# 2. Verify the config block landed:
cat ~/.codex/config.toml
# EXPECTED: [[hooks.UserPromptSubmit]] and [[hooks.SessionStart]]
# blocks between the # stm: ... v1 markers.

# 3. Launch codex (NOT via stm codex — these are global hooks):
codex
# EXPECTED: Codex prompts to trust the hook on first launch. Press y.

# 4. Inside the session, paste a fake-but-shaped key into the prompt:
#   prompt: "here's my key: sk-fakeFAKE1234567890fakeFAKE1234567890"
# EXPECTED: the prompt is BLOCKED. stderr message from the
# UserPromptSubmit hook tells the model to use the {{stm:...}}
# placeholder instead.

# 5. Start a fresh session and check that the SessionStart hook
# injected guidance:
codex
#   prompt: "what API key references can I use?"
# EXPECTED: codex's response references `stm list` and the
# {{stm:tool:label}} placeholder grammar — proves SessionStart
# guidance was injected.

# 6. Verify with the doctor:
stm codex doctor
# EXPECTED: both Option-1 hooks AND Option-2 MCP statuses (the latter
# may be NEEDS ATTENTION if you haven't run install-mcp yet — that's
# fine).
```

### Failure modes to file

- No trust prompt appears on first launch. Codex may have changed
  its trust UX; file with `codex --version`.
- The pasted key in step 4 is NOT blocked. Most likely cause: hook
  not registered, or trust was never granted. Check `stm codex
  doctor`.
- SessionStart guidance does not appear. Less critical (the agent
  can still figure stm out from `stm list`) but worth filing.

---

## 7. Codex Option 2 — MCP-wrapped tools (v0.7.0)

The strongest Codex mode stm hosts. Codex spawns
`stm codex mcp-server` over stdio; the agent discovers a new tool
`stm_http_request` and invokes it instead of running raw curl. The
credential value never enters Codex's address space.

### Steps

```bash
# 1. Install the MCP block (separate from the hooks block — they
# coexist):
stm codex install-mcp
# EXPECTED stdout: hint to restart codex; trust-gate warning.

cat ~/.codex/config.toml
# EXPECTED: [mcp_servers.subscribetome] block with the bun + cli paths,
# delimited by # stm: subscribetome managed-mcp v1 markers.

# 2. Confirm both installers + the doctor are healthy:
stm codex doctor
# EXPECTED: both Option 1 (hooks) AND Option 2 (MCP) OK.

# 3. Restart Codex. On first launch it should prompt to trust the
# MCP server.

# 4. Inside the session, prompt the agent to use the tool:
#   prompt: "Use the stm_http_request MCP tool to call OpenAI's
#    /v1/models endpoint (GET, no body) and show me the first 3
#    model ids."
# EXPECTED: codex invokes the `stm_http_request` tool (visible in
# codex's UI as a tool call). The agent gets back a JSON response
# with model ids. The agent NEVER printed an API key to the chat.

# 5. Posture check — confirm the key didn't leave stm's process:
#   prompt: "Now print the value of $STM_OPENAI_DEFAULT to the chat."
# EXPECTED: codex prints "(unset)" or a placeholder, because in
# Option-2 mode we did NOT inject any STM_* env vars (Option 2 ≠
# Option 1; running `stm codex install-mcp` does NOT also run
# `stm codex` the launcher). The agent has no way to read the key.

# 6. Provider-routing check — try Anthropic instead:
#   prompt: "Use stm_http_request to POST to Anthropic /v1/messages
#    with a small claude-haiku call."
# (Assuming an anthropic:default key is configured.)
# EXPECTED: the tool injects x-api-key (Anthropic's auth header,
# not Bearer) and the call succeeds.
```

### Failure modes to file

- `stm codex install-mcp` writes a block but Codex doesn't show the
  tool in its tool list. Most likely cause: `bun` resolver wrote the
  wrong path (try `stm codex doctor` — it reports `block out of
  date` when the path drifts).
- The agent calls the tool but the response includes the credential
  value (this would mean the MCP server's response-shaping is
  echoing the auth header back — file immediately, this is a security
  regression).
- An agent that explicitly passes `{ "headers": { "Authorization":
  "Bearer fake-injection" } }` and the upstream sees that
  Authorization value instead of stm's — file (the server strips
  agent-supplied auth headers, but this is exactly the path to
  verify).

---

## What to include in a report

When something fails:

1. The exact command + the exact error / wrong output.
2. `stm doctor` output (full text).
3. `stm status` output.
4. Platform info: `uname -a` (Linux/macOS) or `[System.Environment]::OSVersion` (Windows).
5. `bun --version`. For Codex paths: `codex --version` too.
6. The stm version: `cat .claude-plugin/plugin.json | grep version`.

File at https://github.com/matterhornso/subscribetome/issues. Tag
with the surface label (e.g. `windows-backend`, `codex-mcp`).

Thanks. These reports are how the v0.5 – v0.7 work moves from
🧪 smoke-tested to ✅ verified.
