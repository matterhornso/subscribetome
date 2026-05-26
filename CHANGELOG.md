# Changelog

All notable changes to subscribetome. This project is pre-1.0; minor versions
may still change behaviour. Format follows [Keep a Changelog](https://keepachangelog.com).

## [0.9.0] — 2026-05-26

### Rotation flow + PostToolUse mode toggle

The two remaining v1.0-readiness features the audit surfaced: a
proper key-rotation command and the long-deferred PostToolUse
warn-only mode.

- **`stm rotate <tool> <label>`.** Opens the provider's catalog
  dashboard URL (or prints it if `--no-open` / `STM_NO_OPEN=1`),
  reads the new key value from stdin (never argv, never the
  transcript), and swaps the value behind the existing
  placeholder in place. The address `{{stm:tool:label}}` is
  unchanged — every existing hook flow keeps working; only the
  value behind it differs. Backed by a new atomic
  `Store.rotateKey()` method: write new value to keystore under a
  fresh UUID, repoint the inventory row, then delete the old
  keystore entry. Inventory write failure rolls back the new
  keystore write before re-throwing; old-entry-already-missing
  is non-fatal. (`src/store.ts`, `src/cli.ts`, 6 new tests.)

- **PostToolUse warn-only mode**, gated on
  `STM_POSTTOOLUSE_MODE=warn`. The hook still detects + reports
  leaks (same exact-value + key-shape channels as v1), but
  emits an advisory to stderr and exits 0 instead of blocking
  the agent turn. Default behavior is unchanged: anything other
  than `warn` (including unset, or unrecognised values like
  `yolo`) keeps the v1 block-mode. The TODOS.md entry for this
  is now closed. (`src/hooks.ts`, 5 new tests in
  `test/hooks.test.ts`.)

380 → 391 tests. Load-bearing invariants intact: rotation
preserves the placeholder address so audit history through
`{{stm:...}}` is uninterrupted; warn-mode is opt-in (default
stays block); the new value is read out-of-band from stdin.

## [0.8.0] — 2026-05-26

### Early-customer-readiness ship — vault snapshots, sync hints, clean uninstall

Three features the early-customer cohort would have hit hard
without: a working backup/restore path, actionable sync errors,
and a credible exit ramp. Each is independently useful; together
they close the "what if it goes wrong" gaps the v1 pipeline left
open.

- **`stm vault export <file>` / `stm vault import <file>`.** A
  single-file backup of the entire inventory + every active key,
  encrypted with the user's passphrase under the same PBKDF2-SHA512
  600k + AES-256-GCM primitive the Tier 3 vault uses. Export
  bundles the full SQLite database (raw bytes — no schema migration
  concerns on restore) plus a `keychain_ref → value` map, so the
  restored inventory rows still resolve. Import is destructive:
  the current DB is backed up to `<db>.bak.<timestamp>` before
  being replaced. Aliases: `stm vault backup` / `stm vault
  restore`. Verified end-to-end with a real macOS Keychain
  round-trip (`add` → `export` → wipe → `import` → `list` ⇒ key
  resolves; `keychain_ref` UUID preserved). (`src/vault-snapshot.ts`,
  10 new tests.)

- **Actionable sync error hints.** Raw provider errors (e.g.
  `network: ECONNREFUSED 8.8.8.8:443`) get classified and given a
  next-step hint: DNS failures point at VPN/firewall, 401s at
  rotating the admin key, 429s at waiting a minute, TLS errors at
  trust-store / proxy issues, 5xx at the provider's status page.
  `humanizeSyncError(raw): { summary, hint }` exposed for any
  future caller (dashboard could surface the same hint). Unknown
  errors pass through unchanged — better to omit a hint than emit
  a wrong one. (`src/sync.ts`, 14 new tests.)

- **`stm uninstall`** removes every active key from the OS
  keystore, the SQLite inventory + WAL/SHM, the encrypted-vault
  file (if present), the daemon descriptor, and Codex's
  hook/MCP blocks from `~/.codex/config.toml`. The Claude Code
  plugin's own hook registration is owned by Claude Code (run
  `/plugin uninstall stm` to finish). Interactive `YES`
  confirmation by default; `--yes` skips it, `--dry-run` just
  prints the plan. (`src/uninstall.ts`, 7 new tests.)

- **`src/version.ts` extracted** as the single source of truth
  for `STM_VERSION`. `src/cli.ts` re-exports for backward
  compatibility with the v0.7.3 wiring.

349 → 380 tests. No load-bearing invariant changes — the
passphrase still controls vault decryption, uninstall is
explicit-confirmation-by-default, snapshot files chmod 0600.

## [0.7.3] — 2026-05-26

### `stm --version` — universal CLI version flag

Every CLI is expected to print its version when asked. stm
didn't, until now.

- **`stm --version` / `stm -v` / `stm version`** all print
  `stm <version>` to stdout. The version string is imported from
  `package.json` at module load so the plugin manifest is the
  single source of truth — no drift between the published version
  and what the CLI reports.
- **Exposed as `STM_VERSION`** from `src/cli.ts` for any future
  caller that wants to read it programmatically (e.g. the
  dashboard could show it in the footer).
- **New test file** `test/cli-version.test.ts` asserts that all
  three spellings emit the same string AND that `package.json`,
  `.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`
  agree on the version. A missed bump in any of the three fails
  the suite — drift insurance. 345 → 349 tests.
- **Top-level `stm --help`** advertises the new flag at the
  bottom of the command list.

## [0.7.2] — 2026-05-26

### QA cleanup — code hygiene from the v0.7.1 audit

Minor maintenance ship after the v0.7.1 QA pass surfaced a handful
of small leftovers. No new features, no behavior changes; the
externally-visible surface is identical to v0.7.1.

- **macOS FFI: `SecKeychainItemRef` is now `CFRelease`d in
  `deleteGenericPassword`.** The v0.6.1 FFI rewrite documented the
  per-call ref leak as acceptable for one-shot CLI invocations
  (the OS reclaims on process exit), but the long-lived dashboard
  daemon does deletes too. Bound `CoreFoundation.CFRelease` via a
  second `dlopen` and call it unconditionally after
  `SecKeychainItemDelete` — whether or not the delete itself
  succeeded — so the itemRef returned by find never lingers past
  one call. (`src/keystores/mac.ts`)

- **Dropped the dead `read` import in `mac.ts`.** The v0.6.1 patch
  imported `read` from `bun:ffi` "for future helpers" and added a
  `void read;` line to suppress the linter. Removed both — easier
  to add when actually needed than to carry as a smell.

- **New real-FFI smoke test for macOS.** The v0.6.1 test file uses
  an injected `MacFFI`, which left the real `realMacFFI()` delete
  path with zero coverage. New
  `test/keystores-mac-real-ffi.test.ts` rounds-trips set → get →
  delete against the real Security framework on darwin (skipped on
  every other platform) and covers upsert, repeated delete→re-add,
  multibyte UTF-8 secrets, and the missing-entry null. Closes the
  one coverage gap the QA audit found. 340 → 345 tests.

- **Top-level `stm --help` now points at `stm codex --help`** for
  the install-hooks / install-mcp / doctor sub-commands. The
  Codex sub-commands were always discoverable via `stm codex
  --help`, but a user reading just the top help wouldn't know
  they existed.

- **README "two agents" reconciliation.** The Codex section
  listed three rows (Claude Code, Codex Option 1, Codex Option 2)
  under the heading "stm wraps two agents today". Rewrote the
  intro line to say "Claude Code and Codex, with two Codex
  integration modes" — same content, no internal inconsistency.

- **`docs/index.html` JSON-LD `dateModified` + `softwareVersion`
  and `docs/sitemap.xml` `lastmod`** bumped to today. SEO crawler
  hygiene only; no user impact.

## [0.7.1] — 2026-05-25

### Docs — backlog sweep + field-verification checklist

Closing-out ship after the v0.5 – v0.7 cross-platform/Codex run.
Documentation-only — no code changes.

- **`TODOS.md` rewritten.** Removed every item that has since shipped
  (audit log, Linux + Windows keychain backends, the macOS argv
  exposure fix, non-Claude-Code agents). What remains is the
  genuinely-pending v1.5+ backlog: managed-manager import (1Password
  / Doppler / Infisical by pointer), provider-side rotation,
  retroactive subscription discovery, PostToolUse warn-only mode.
  Plus cross-references to spec-tracked deferrals (Stripe spend,
  catalog search, audit-log `leak` event), the one external blocker
  (openai/codex#18491 for Codex per-command rewrite), and the
  post-v1 candidates without specs yet (more MCP providers, opencode
  / Cursor adapters, spend forecasting). Each entry has acceptance
  criteria for a future build session.

- **`FIELD_VERIFICATION.md` (NEW)**. Per-surface checklist for
  community users with the hardware to confirm the v0.5 – v0.7
  builds end-to-end. Covers:
    * Linux Secret Service (v0.3.1)
    * Linux Pass tier 2 (v0.6.0) — incl. an `strace`-based posture
      check that the secret never lands in argv
    * Linux EncryptedFile tier 3 (v0.6.0) — incl. the hook
      fail-safe contract under non-TTY without `STM_FILE_PASSPHRASE`
    * Windows Credential Manager backend (v0.5.0) — incl. a
      PowerShell `Get-Process | Select CommandLine` posture check
    * Codex Option 1 session-env launcher (v0.4.0)
    * Codex hooks port (v0.4.1) — incl. trust-gate flow
    * Codex Option 2 MCP-wrapped (v0.7.0) — incl. agent-supplied
      Authorization-override stripping check
  Each section has exact commands, expected output, specific
  failure modes to file, and what to include in a bug report.

- **README** grows a one-line pointer to `FIELD_VERIFICATION.md`
  under "Supported platforms".

### Tests

No new tests. The suite is 340 pass, 0 fail (unchanged from v0.7.0).

## [0.7.0] — 2026-05-25

### Added — Codex Option 2: MCP-wrapped tools (`specs/cross-platform-and-codex.md` §6 Option 2)

The strongest Codex mode stm can host today. Option 1 (v0.4.0,
session-env) put the key in codex's process environment for the
whole session — a weaker guarantee than Claude Code's per-command
rewrite. Option 2 keeps the key entirely inside stm's MCP-server
process; the agent invokes a named tool and never handles the
secret. This is the structurally closest equivalent to Claude Code's
guarantee that Codex can host without `updatedInput`.

- **`src/agents/codex-mcp.ts`** (NEW) — JSON-RPC 2.0 MCP server
  over stdio. Implements the three methods Codex needs:
  `initialize`, `tools/list`, `tools/call`. One tool exposed:
  `stm_http_request(provider, path, method?, query?, headers?, body?)`.
  Server resolves the credential through the existing KeyStore at
  the moment of each call (so a rotated key takes effect on the
  next request) and injects the auth header on the outbound HTTPS
  request. The credential is never:
    * placed in the JSON-RPC RESPONSE to the agent,
    * logged to stderr,
    * passed in any tool-call argument.

- **`src/agents/codex-mcp-providers.ts`** (NEW) — v0.7.0 launch
  set: OpenAI (Bearer), Anthropic (x-api-key + anthropic-version
  pin), Stripe (Basic, Stripe-style key-as-username), GitHub
  (Bearer + accept header), Resend (Bearer). Adding a provider is
  one entry — the pattern generalizes. Auth-header builder is a
  centralized switch (bearer / x-api-key / basic-user) so a future
  scheme is one new arm.

- **Defense-in-depth on agent-supplied headers.** The tool schema
  description tells the agent NOT to provide an `Authorization`
  header. The server ALSO strips `Authorization` / `authorization`
  / `x-api-key` / `X-API-Key` from the agent-supplied headers
  before injecting its own — so a misbehaving (or compromised)
  agent can never override stm's auth header with its own value.

- **`src/agents/codex-mcp-install.ts`** (NEW) — installer + doctor
  for the `[mcp_servers.subscribetome]` block in
  `~/.codex/config.toml`. Symmetric with the v0.4.1 hooks installer
  but uses a DIFFERENT marker pair (`# stm: subscribetome managed-
  mcp v1` / `# stm: end subscribetome managed-mcp`) so the two
  installers are independent — users can run hooks-only, MCP-only,
  both, or neither. The block points Codex at
  `bun src/cli.ts codex mcp-server`, resolved to absolute paths at
  install time (Codex spawns child processes in its own
  environment, which may differ from the user's shell PATH).

- **Refactor**: `rewriteOrAppendBlock` + `removeBlock` in
  `codex-hooks.ts` lifted to take marker-pair parameters. The
  install/uninstall logic for both blocks now shares one
  battle-tested splice helper.

- **New CLI subcommands:**
  - `stm codex install-mcp [--dry-run] [--remove]` — write,
    refresh, or remove the MCP block. Backs up the previous config.
  - `stm codex mcp-server` — the entrypoint Codex spawns. Speaks
    JSON-RPC 2.0 over stdio. Not for direct human use.

- **`stm codex doctor` extended** — now reports both Option 1
  (hooks) and Option 2 (MCP) tracks. Exits 1 if either has an
  issue; CI-friendly.

### Tests — 340 pass, 0 fail (was 292; +48 v0.7.0 tests across 3 files).

- `test/codex-mcp.test.ts` (24 tests). **HEADLINE TESTS:**
  (a) credential value never appears in the JSON-RPC response;
  (b) credential value IS placed in the upstream Authorization
      header; (c) an agent that tries to override Authorization
      has its header stripped before the server injects its own.
  Also: per-scheme auth (Bearer / x-api-key / Basic), URL
  building with query params, JSON vs form-encoded body shaping,
  provider default headers (anthropic-version etc.), unknown
  provider / missing credential / bad path / oversize response /
  upstream 429, JSON-RPC framing (unknown method, malformed
  envelope, notification with no id).
- `test/codex-mcp-providers.test.ts` (10 tests). Registry shape,
  buildAuthHeader scheme matrix, tool schema integrity.
- `test/codex-mcp-install.test.ts` (14 tests). Idempotent install,
  preserves user content, replaces stale blocks, coexists with
  the v0.4.1 hooks block without stomping each other, uninstall
  keeps the hooks block alive, doctorMcp verdict matrix.

### Compatibility

- v0.4.x Codex Option 1 (session-env) continues to work unchanged
  for users who haven't installed Option 2. Both modes can coexist
  — the MCP block uses a separate marker pair from the hooks
  block.
- No new outbound calls at stm-startup time. The MCP server only
  makes outbound calls when the agent invokes the tool — same
  user-initiated posture as `stm sync`.
- Zero runtime deps. The JSON-RPC server is hand-rolled (not
  `@modelcontextprotocol/sdk`) to preserve the project's
  zero-deps invariant.

### Notes

- Real-host verification: the MCP server's JSON-RPC handshake +
  tools/list pass a synthetic smoke test (echo two requests on
  stdin, parse the replies). The full agent loop under a real
  Codex CLI session has not been exercised on this build host —
  install the block via `stm codex install-mcp`, restart Codex,
  and the agent will see `stm_http_request` as a discoverable
  tool. Codex may prompt to TRUST the MCP server on first
  launch (same trust gate as the hooks installer; surfaced in
  the install-mcp success message).
- Future: more providers (the v0.7.0 launch set is OpenAI /
  Anthropic / Stripe / GitHub / Resend — five tested, with the
  pattern documented for others to PR). Per-provider tools
  (e.g. `openai_chat_completion`) above the generic
  `stm_http_request` if usage shows the generic surface is too
  raw.

## [0.6.1] — 2026-05-25

### Changed — macOS Keychain backend now FFI-based (closes the v1 argv exposure)

The v1 backend ran `/usr/bin/security add-generic-password -w <value>`,
which left the secret briefly visible to a local `ps` during the
write. This was the last "known limitation" remaining from v1's
posture story — the spec called it out, and v0.3.1 (Linux) + v0.5.0
(Windows) shipped strictly-better alternatives for those platforms.
This release closes it on macOS too. Posture parity across all three
desktop OSes.

- **`src/keystores/mac.ts`** rewritten to call the macOS Security
  framework directly via Bun FFI against
  `/System/Library/Frameworks/Security.framework/Security`:
    - `SecKeychainAddGenericPassword`     (write)
    - `SecKeychainFindGenericPassword`    (read; out-param + free)
    - `SecKeychainItemDelete`             (chained after find)
    - `SecKeychainItemFreeContent`        (release the read buffer)
  The secret bytes go into the `passwordData` pointer parameter,
  never as an argv element or stdin fd.

- **`src/keystores/types.ts`** gains `MacFFI` — the four-method
  injectable surface. Tests pass a recording fake so the suite
  runs on any host without touching the real Keychain. Mirrors
  the v0.5.0 `WincredFFI` pattern.

- **Lazy FFI resolution.** `createMacKeyStore({ffi?})` defers the
  real `dlopen("Security.framework")` call until the first op.
  `describe()` is callable from anywhere — useful for the dashboard
  pill and `stm status` rendering the configured backend on a
  misconfigured host.

- **Upsert semantics preserved.** v1's `security -w -U` upsert flag
  is matched by a delete-then-retry when the framework reports
  `errSecDuplicateItem`. Concurrent readers are not affected
  (the entry is only briefly absent in the duplicate case, never on
  fresh writes).

- **Resolver wiring.** `SelectOptions` grows `macFFI?` for test
  injection — symmetric with the v0.5.0 `wincredFFI`.

- **`isMacKeychainReachable({ffi?})`** added for resolver-level
  probing. Returns false when the framework can't be loaded or the
  keychain is locked / restricted — the resolver then surfaces
  `unsupported (...)` rather than silently degrading. Same pattern
  as `isWincredReachable` from v0.5.0.

### Tests — 292 pass, 0 fail (was 277; +18 mac-ffi tests, –3 obsolete shell-out tests).

`test/keystores-mac-ffi.test.ts` covers:
- Headline: secret never appears in any string-shaped FFI parameter
  (service / account). Bytes only live in the `blob` Uint8Array.
- UTF-8 round-trip survives DPAPI-equivalent encoding.
- `errSecItemNotFound` (-25300) on read returns null; other codes throw.
- `errSecDuplicateItem` (-25299) on add triggers delete-then-retry.
- `isMacKeychainReachable` true on healthy FFI, false on throwing FFI
  or non-NotFound status code.
- Resolver picks the new backend on `darwin` with optional `macFFI`
  injection; `STM_KEYSTORE=keychain` alias forwards the injection too.

Plus a refresh in `test/keystores.test.ts` — the v1 "shells out to
`security`" tests are replaced with a lazy-describe test and an
injected-FFI round-trip.

### Compatibility

- Same KeyStore interface as v0.6.0. Every consumer (`store.ts`,
  `hooks.ts`, the daemon) sees the same `set` / `get` / `delete` /
  `describe` surface. No API breaks.
- Label is unchanged — `describe()` still returns `"macOS Keychain"`.
  The dashboard pill, `stm status`, and any tests that asserted the
  label continue to pass.
- Existing keychain entries written by v0.6.0 (via the CLI) ARE
  readable by the new FFI binding — both wrote a generic-password
  item under the same service+account namespace, which is what the
  FFI call also operates on.
- Zero new outbound calls. The FFI binding is purely local.

### Note

- `/usr/bin/security` is no longer invoked by the backend. The
  binary is still useful for one-off inspection (e.g. `security
  find-generic-password -s subscribetome -a <ref> -g`) but stm
  itself never spawns it.
- `node:child_process.spawnSync` is no longer imported by
  `mac.ts`. The `SpawnFn` interface stays in `types.ts` because
  the Linux SS and Linux Pass backends still use it.

## [0.6.0] — 2026-05-25

### Added — Linux headless tiers 2 + 3 (`specs/cross-platform-and-codex.md` §5 Linux row; build plan: `specs/plans/v0.6-linux-headless.md`)

The resolver now ships a three-tier fallback chain on Linux. macOS,
Linux desktop, Linux headless (SSH / container / WSL / CI), and
Windows are now all first-class supported environments — no Linux
host is "platform unsupported" anymore.

- **`src/keystores/linux-pass.ts` (NEW) — Tier 2.**
  Uses `pass(1)` + GPG. Each secret is one file under
  `~/.password-store/subscribetome/<ref>`, encrypted to the user's
  GPG key. `set` writes via stdin (`pass insert --multiline -f`),
  so the secret never appears as an argv element — same posture as
  the Linux Secret Service backend, same strict improvement over
  macOS v1.
  - `probeLinuxPass` verifies BOTH `pass version` and `pass ls`
    exit 0, catching the common "pass installed but no GPG store
    initialised" failure mode.

- **`src/keystores/encrypted-file.ts` (NEW) — Tier 3, opt-in.**
  Last-resort backend for headless hosts without Secret Service
  AND without `pass`. One file at
  `$XDG_DATA_HOME/subscribetome/keys.enc` (default
  `~/.local/share/subscribetome/keys.enc`), mode 0600. Crypto:
    - **KDF**: PBKDF2-SHA512, 600 000 iterations (OWASP-2025
      current). KDF ID byte = 1; reserved 2 for Argon2id in v0.6.1.
    - **Cipher**: AES-256-GCM. Per-file 16-byte random salt;
      fresh 12-byte IV per write. The GCM tag is the last 16
      bytes — a wrong passphrase yields a clear "decryption
      failed" error, never silent corruption.
    - **File layout (53-byte overhead)**: `magic (8) | kdf_id (1)
      | salt (16) | iv (12) | ciphertext+tag`.
  - Atomic writes via `tmp + rename`.
  - Implementation note: uses `node:crypto` (`pbkdf2Sync`,
    `createCipheriv`) for genuinely synchronous primitives. The
    KeyStore interface is sync — calling WebCrypto's async API
    would have meant churning every existing caller.

- **Passphrase UX (spec §7 #3 — fiddliest piece in the roadmap).**
  Three sources, in order:
    1. In-process cache pre-warmed by `stm vault unlock`.
    2. `$STM_FILE_PASSPHRASE` env var (CI / devcontainers).
    3. Interactive prompt on stderr — ONLY when stdin AND stderr
       are TTYs.
  **Critical fail-safe**: when none of the three yield a passphrase,
  `get()` returns null instead of throwing. The PreToolUse hook
  exits 0 without rewriting, so the command runs with the
  placeholder intact and fails harmlessly. We never block a hook
  on a missing passphrase, and we never leak which key we
  couldn't resolve into the audit log.

- **Tiered resolver** in `src/keystores/index.ts`:
  - Linux branch tries Tier 1 → Tier 2 → Tier 3 in order. The
    first reachable tier wins; never a silent downgrade (the
    gh-CLI cautionary tale from §5 still binds).
  - Tier 3 is gated by `STM_ALLOW_FILE_BACKEND=1` on first touch.
    Once the vault exists, the file's existence IS the consent
    for subsequent runs.
  - New `STM_KEYSTORE` aliases: `linux-pass`, `pass`,
    `encrypted-file`, `file`, `encrypted`.

- **`stm doctor` (NEW CLI subcommand).** Pure structured report of
  every tier: which is active, which is unreachable + why, exact
  fix commands (e.g. `apt install pass; pass init <your-gpg-id>`).
  Exits 0 on healthy, 1 otherwise — CI-friendly.

- **`stm vault` (NEW CLI subgroup).**
  - `stm vault unlock` — reads a passphrase from stdin, pins it in
    the in-process cache so subsequent set/get/delete don't prompt
    again. Long-lived consumers (daemon, Claude Code session) need
    their own unlock if they restart.
  - `stm vault rotate-passphrase` — decrypts the vault under the
    old passphrase, re-encrypts under a new one, atomically
    replaces the file, and leaves a timestamped `.bak.<ts>` for
    rollback. Wrong old passphrase aborts before touching the
    file.
  - `stm vault info` — file path / mode / size / magic / KDF
    diagnostics.

### Tests — 277 pass, 0 fail (was 232; +45 v0.6 tests).

Three new test files:
- `test/keystores-linux-pass.test.ts` (~10 tests). Headline:
  secret NEVER in argv on `pass insert` — value lives in stdin.
- `test/keystores-encrypted-file.test.ts` (~21 tests). Crypto
  round-trip, wrong-passphrase rejection, magic / KDF-id checks,
  file mode 0600, rotatePassphrase (success, missing-file,
  wrong-old-passphrase), inspectEncryptedFile, XDG path
  resolution.
- `test/keystores-tier-resolver.test.ts` (~10 tests). The cross-
  tier matrix: Tier 1 picked when reachable, Tier 2 falls through
  correctly, Tier 3 ONLY with opt-in or pre-existing file (never
  silent), `STM_KEYSTORE` alias matrix, `doctorReport` for
  darwin / linux-no-tiers / linux-with-vault.

Plus three updated tests in `test/keystores.test.ts` (the old
single-tier Linux unsupported tests were obsolete — replaced with
"all-tier-failure" + "Tier 1 → Tier 2 fall-through" + "Tier 2 →
Tier 3 opt-in" tests).

### Surface

- README "Supported platforms" grows a tiered description for the
  Linux headless story and a new "Encrypted-file vault (Tier 3) —
  passphrase UX" subsection.
- `stm doctor` is the canonical way for users to understand their
  tier situation; the launch banner / dashboard pill defer to
  `activeKeyStore().describe()` as before — they automatically
  render the new labels (`Linux Pass (pass + GPG)`,
  `EncryptedFile (0600, PBKDF2-SHA512)`).
- Landing page: roadmap row + trust strip + FAQ + JSON-LD all
  reflect the v0.6.0 coverage. "All major desktop OSes" is now
  literally true.
- `docs/llms.txt` updated.

### Compatibility

- No behaviour change for any existing macOS / Linux desktop /
  Windows user. Tier 1 (Secret Service) is still the default on
  desktops; if it's reachable, the resolver picks it before
  even trying Tier 2 or 3.
- No new outbound calls. The tier 2 + 3 backends are purely local
  (pass uses GPG, encrypted-file uses node:crypto).
- The hook fail-safe contract holds: when the encrypted-file
  backend can't unlock, `get()` returns null and PreToolUse exits
  0 without rewriting — same behaviour as a missing key on
  Tier 1.

### Notes

- Argon2id (KDF ID 0x02) is reserved in the file format for
  v0.6.1. PBKDF2-SHA512 at 600 000 iterations is OWASP-2025-current
  and was the right "ship without vendored implementation risk"
  choice.
- WSL routing remains its own case (WSL processes see `platform:
  'linux'` and now reach Tier 3 if the user opts in; native
  Windows Credential Manager via interop is tracked for a future
  ship).
- The macOS argv-exposure limitation is still open. Bun-FFI
  rewrite of the macOS backend (template = the v0.5.0 Windows
  backend) is the natural follow-up.

## [0.5.0] — 2026-05-25

### Added — Windows Credential Manager backend (`specs/cross-platform-and-codex.md` Workstream B; build plan: `specs/plans/v0.5-windows-backend.md`)

stm now supports the third major desktop OS. macOS, Linux desktop, and
Windows all reach the same "strong" guarantee on Claude Code (per-command
rewrite) and the session-env mode on Codex.

- **`src/keystores/windows-credential.ts`** — Windows backend.
  Talks to advapi32.dll directly via Bun FFI: `CredWriteW`,
  `CredReadW`, `CredDeleteW`, plus `CredFree` for the OS-allocated
  CREDENTIALW. `kernel32!GetLastError` exposed for distinguishing
  ERROR_NOT_FOUND from a real failure.

- **Posture — strict improvement over macOS.** The macOS v1 backend
  shells out to `security add-generic-password -w <value>`, briefly
  exposing the secret to a local `ps`. Linux Secret Service (v0.3.1)
  closed that hole by piping via stdin. Windows closes it more
  cleanly: the secret bytes live in a Uint8Array we own and pass to
  CredWriteW by pointer — they go directly into
  `CREDENTIALW.CredentialBlob`. There is no argv element, no stdin
  fd, no environment variable in play. Headline test:
  `test/keystores-windows.test.ts > WindowsCredential.set never
  passes the secret as the targetName (argv-equivalent)`.

- **`src/keystores/types.ts`** gains the `WincredFFI` interface.
  Backends call the interface, never the FFI directly — tests
  inject a recording fake (which is also what lets the suite run
  on a macOS dev box without an advapi32 to dlopen).

- **Resolver wiring** in `src/keystores/index.ts`:
  - `process.platform === "win32"` → probe via
    `isWincredReachable(...)`. If probe throws or returns a non-
    ERROR_NOT_FOUND error code, hand back an honest `unsupported
    (...)` keystore with a friendly hint (sandbox? service
    account? no Credential Manager?). The spec's "never silently
    fall back to plaintext" invariant continues to hold.
  - New aliases on `STM_KEYSTORE`: `windows`, `windows-credential`,
    `wincred`, `credential-manager`.

- **Lazy FFI resolution.** `createWindowsCredentialKeyStore({ffi?})`
  defers the real `dlopen("advapi32.dll")` call until the first
  op (`set` / `get` / `delete`). `describe()` is callable from
  anywhere — useful for the dashboard pill and `stm status`
  rendering the configured backend even on a misconfigured host.

- **Target-name namespace**: `Subscribetome:<ref>`. Visible in
  `Credential Manager` (control panel) and `cmdkey /list` under
  that prefix; mirrors the Linux SS service attribute.

### Tests — 231 pass, 0 fail (was 209; +22 windows-backend tests).

`test/keystores-windows.test.ts` covers:
- Headline: secret never appears in targetName (the argv-equivalent
  for the FFI surface).
- Namespace: target is `Subscribetome:<ref>`.
- set/get round-trip; UTF-8 byte encoding survives DPAPI.
- get returns null on ERROR_NOT_FOUND, throws on other failures.
- delete is idempotent on ERROR_NOT_FOUND, throws otherwise.
- `isWincredReachable` returns true on a healthy FFI, false on a
  throwing FFI, false on a non-NOT_FOUND error code.
- Resolver picks Windows on `win32` with reachable FFI; returns
  `unsupported (...)` when the FFI throws; honours
  `STM_KEYSTORE=wincred` from any platform.
- `describe()` is lazy and doesn't need a working FFI.
- Multi-key isolation and 2KB value handling (well under the
  Credential Manager 2560-byte blob limit).

`test/keystores.test.ts` also gained two new tests (win32 picks the
new backend; win32 with broken FFI is honest) and one was rewritten
(the old "win32 is unsupported" test became obsolete). The "no mapping"
branch is still verified via a `freebsd` platform test.

### Surface

- `stm status` now reads `keystore : Windows Credential Manager
  (DPAPI)` on Windows hosts. No code change — the existing
  `activeKeyStore().describe()` line renders whatever the resolver
  selected. Same applies to the dashboard pill (`GET /api/inventory`
  → `keystore` field).
- README "Supported platforms" section now lists Windows
  explicitly with the wincred / Bun FFI explanation. The "Windows
  — not yet supported" line is gone.
- Landing-page hero / trust strip / JSON-LD `operatingSystem`
  ("macOS, Linux, Windows") / FAQ all updated.
- `docs/llms.txt` paragraph refreshed.

### Compatibility

- No behaviour change for any existing macOS or Linux user.
- The `STM_KEYSTORE` aliases from v0.3.1 (mac/macos/keychain/
  linux/libsecret/secret-service/linux-secret-service) still work.
- The `KeyStore` interface from v0.3.1 was sufficient; no breaking
  changes. The new `wincredFFI?` field on `SelectOptions` is
  optional and exists only for test injection.

### Known limitations / v0.5.x follow-ups

- The real Bun FFI binding has NOT been hardware-verified on a
  Windows host as part of v0.5.0 — the codebase was built on macOS,
  every test path goes through an injected FFI. Field testing
  welcome. The bun:ffi calls follow the documented advapi32 ABI
  (CREDENTIALW layout stable since Windows 2000); the most likely
  thing to fail in practice is bun:ffi pointer-read semantics on
  the OS-allocated CREDENTIALW, which is exactly the part the
  injected tests can't cover.
- WSL is still its own case — WSL processes see `platform: 'linux'`
  and will hit the Linux Secret Service branch. WSL→Windows interop
  via `/mnt/c/...` is tracked separately (spec §5 WSL row).
- The macOS argv-exposure limitation remains unchanged in this
  release; Bun-FFI rewrite of the macOS backend is a v0.5.x patch
  candidate. The Windows backend is a worked example of how to
  do it.

## [0.4.1] — 2026-05-24

### Added — Codex guardrail hooks port (`specs/cross-platform-and-codex.md` §6, follow-up)

The v0.4.0 launcher closed the env-injection half of Codex support; the
guardrails (UserPromptSubmit, SessionStart) were deferred. This release
ports them.

- **`hooks/codex/userpromptsubmit.sh`** and
  **`hooks/codex/sessionstart.sh`** — thin shell wrappers, identical
  in spirit to the Claude Code versions. The hook code in
  `src/hooks.ts` works on Codex unchanged: Codex's stdin payload
  (`prompt`, `cwd`, `hook_event_name`, snake_case) matches the
  fields we read; the `hookSpecificOutput` reply (camelCase) and
  the exit-code-2 + stderr blocking semantics are identical
  to Claude Code's.

- **`src/agents/codex-hooks.ts`** — the installer + doctor.
  - `installHooks({configPath?, dryRun?})` writes (or refreshes)
    a marker-delimited managed block in `~/.codex/config.toml`
    with the array-of-tables schema Codex's hook docs specify:
    `[[hooks.UserPromptSubmit]]` + `[[hooks.UserPromptSubmit.hooks]]`
    with `type = "command"` and an absolute `command` path,
    plus the matching `SessionStart` block. Sets
    `features.hooks = true` defensively.
  - Idempotent and surgical: the block sits between
    `# stm: subscribetome managed-hooks v1` and
    `# stm: end subscribetome managed-hooks` markers. Reinstalling
    rewrites just the block; everything above and below the
    markers is preserved verbatim. A backup of the previous
    config is written next to the file when a change occurs.
  - `doctor({configPath?})` reads the file and returns a verdict
    (config present? block present? block up to date? scripts
    executable?) — used by the CLI subcommand AND by the
    launch banner.
  - `uninstallHooks(...)` is the symmetric remove for users who
    want the launcher without the guardrails.

- **CLI**:
  - `stm codex install-hooks [--dry-run]` — adds (or refreshes)
    the managed block. Backs up the previous config.
  - `stm codex install-hooks --remove` — uninstalls cleanly.
  - `stm codex doctor` — read-only health check; exits 0 on OK,
    1 otherwise. Suitable for CI.
  - `stm codex` (the launcher) now calls `doctor()` once at
    launch time so the banner shows
    `guards: UserPromptSubmit + SessionStart installed` or
    `guards: NOT installed — run \`stm codex install-hooks\``.

- **Trust gate warning** — surfaced in three places: the
  install-hooks success message, the doctor summary, and the
  Codex hooks reference link. Per Codex docs
  (developers.openai.com/codex/hooks#trust), the FIRST launch
  after install will prompt the user to approve the hook; until
  they do, the hook is silently skipped. We never let this fact
  hide.

### Tests — 207 pass, 0 fail (was 192; +15 codex-hooks tests).

Coverage:
- `renderManagedBlock` emits the correct array-of-tables shape,
  both event sections, both `type = "command"` entries, and
  absolute paths.
- `installHooks` creates the file on first install, is idempotent
  on re-run, preserves surrounding user config, replaces a stale
  managed block in place, and writes with mode 0600.
- `--dry-run` writes nothing.
- `uninstallHooks` removes the managed block while preserving
  other content; no-op on a missing block or missing file.
- `doctor` reports missing/present/out-of-date/scripts-missing
  correctly and always surfaces the trust-gate reminder when the
  block is present.

### Compatibility

- Existing v0.4.0 Codex launches continue to work unchanged. The
  hook port is purely additive — `stm codex` still launches codex
  whether or not `install-hooks` has run.
- No new outbound calls. The hook scripts and the installer
  touch only the local filesystem.
- Audit log invariant unchanged (the hook code path that writes
  audit rows is the same one Claude Code uses; it never carries a
  real key value).

## [0.4.0] — 2026-05-24

### Added — Codex adapter (`specs/cross-platform-and-codex.md` Workstream C, Option 1)

stm now wraps a second agent: the OpenAI Codex CLI. Until openai/codex#18491
lands `updatedInput` support, Codex cannot do per-command rewrite the way
Claude Code does. The spec's "Option 1: session-env mode" ships now;
"Option 2: MCP-wrapped tools" remains tracked for a later release.

- **`src/agents/codex.ts`** — the Codex injection model.
  - `keyEnvName(tool, label)` — deterministic mapping to
    `STM_<TOOL>_<LABEL>` (uppercased; non-`[A-Z0-9_]` characters
    become underscores). Same input always produces the same env
    var name, so the user can prompt codex with `use $STM_OPENAI_DEFAULT`
    or let the agent discover names via `env`.
  - `buildInjectionPlan({ store, cwd })` — picks the keys to expose.
    When `cwd` matches a registered project (longest-prefix), uses
    ONLY that project's scoped keys; otherwise injects ALL active
    keys. Empty-scope project falls back to "all active keys" with
    `scoped: false` so the banner can say so honestly.
  - **Collision detection** — two `(tool, label)` pairs that map to
    the same env var name surface a `collisions` list; the launcher
    REFUSES to start. Silent overwrites are exactly the failure mode
    the spec warns about.
  - `resolveInjectionValues` — pulls every entry's value from the
    keystore; throws (never returns half) if any required key is
    missing.
  - `launchCodex({ values, userArgs, spawnFn? })` — spawns the
    `codex` binary with values in the child's process env and
    `-c shell_environment_policy.inherit="all"` /
    `-c shell_environment_policy.include_only=["STM_*"]` in argv,
    so Codex passes our STM_* vars through to agent shells
    (overriding Codex's default KEY/SECRET/TOKEN scrubbing). The
    real values appear nowhere in argv and nowhere on disk.
  - `launchBanner(plan)` — printed to stderr at every launch.
    Spells out the security framing verbatim ("the real key sits
    in codex's process environment for the whole session … WEAKER
    than Claude Code's per-command injection") and lists every
    injected env var by NAME (never value).

- **`stm codex [codex-args...]`** — new CLI subcommand. Forwards
  args to `codex` after the policy overrides. `--dry-run` prints
  the injection plan without launching, useful for verifying which
  keys would be exposed.

- **Agent label everywhere** — `stm status` and the dashboard now
  show the agents stm wraps and each one's security posture:
  `Claude Code (per-command rewrite) · Codex (session-env mode)`.
  Per the spec, the active agent's trade-off must never be hidden.
  `GET /api/inventory` returns the `agents` array.

### Changed

- README "Supported platforms" section grew an "Agents" subsection
  documenting Claude Code (per-command rewrite, transcript-clean)
  vs. Codex (session-env mode, weaker — process env, whole session).
- Landing-page hero / agents row reflects the second agent.

### Notes — what's not shipped

- **Codex hook port** (`UserPromptSubmit` / `SessionStart`
  guardrails). The spec §6 says these DO port — same event, same
  `additionalContext` shape — but Codex's hook config surface is
  slightly different from Claude Code's. Tracked for v0.4.x.
- **Option 2 (MCP-wrapped tools)** — higher-assurance Codex mode
  where the agent never sees a key. Bigger build; opt-in. Tracked
  for a v0.5 milestone.
- **Cross-platform Workstream A tiered fallback** (LinuxPass +
  EncryptedFile for headless Linux) and **Workstream B** (Windows
  Credential Manager) — still pending. The new `KeyStore`
  interface from v0.3.1 is the seam they'll plug into.

### Tests

- 192 pass, 0 fail (was 170; +22 codex adapter tests).
- Critical assertion: secret values NEVER appear in the argv passed
  to codex — only env-var names. Verified directly via the fake
  spawn in `test/codex.test.ts`.

## [0.3.1] — 2026-05-23

### Added — Linux Secret Service backend (`specs/cross-platform-and-codex.md` Workstream A)

stm is no longer macOS-only. Linux desktop hosts running a libsecret-
compatible keyring daemon (gnome-keyring, kwallet's secret-service
shim) now get a Linux-native KeyStore backend.

- **`KeyStore` interface** in `src/keystores/types.ts` — the abstraction
  seam the spec called for. Every per-OS backend implements `set`,
  `get`, `delete`, `describe`. Two implementation rules are
  load-bearing: secrets are passed via stdin (not argv) wherever the
  underlying tool supports it, and `get` returns null for "not
  found" rather than throwing.
- **macOS backend** (`src/keystores/mac.ts`) — extracted from the v1
  inline `keychain.ts` code, unchanged behavior.
- **Linux Secret Service backend**
  (`src/keystores/linux-secret-service.ts`) — uses `secret-tool`
  (libsecret CLI). The secret is piped via stdin, NOT passed as an
  argv element — a strict posture improvement over macOS's `security
  -w <value>` (which the spec calls out as a known v1 limitation).
- **Resolver** (`src/keystores/index.ts`) with three-tier selection:
    1. `STM_KEYSTORE` override (`mac` / `macos` / `keychain` /
       `linux-secret-service` / `libsecret` / `secret-service` / …)
    2. Platform default — darwin → MacKeychain; linux → LinuxSecretService
       when `secret-tool` is on PATH AND a D-Bus probe succeeds.
    3. Friendly `unsupported` store on platforms with no mapping yet
       (Windows, BSD). The resolver NEVER silently falls back to
       plaintext — the spec calls out gh CLI as the cautionary tale.
- **Active-backend visibility**: `stm status` and the dashboard
  header now show which keystore is live ("macOS Keychain", "Linux
  Secret Service (libsecret)", or the `unsupported (...)` reason).
  Per the spec, the active backend is never hidden from the user.
- `GET /api/inventory` now includes a `keystore` field for the
  dashboard pill.

### Changed
- `src/keychain.ts` is now a thin shim that delegates to
  `getKeyStore()`. The public `keychainSet/Get/Delete` surface is
  unchanged — store.ts, hooks.ts, daemon.ts, and the existing test
  suite see no API drift. 170 tests pass, 0 fail (was 149; +21
  keystore tests).
- README "Limitations (v1)" → "Supported platforms" section
  documenting macOS, Linux desktop, and the still-pending headless
  Linux + Windows roadmap. The v1 "macOS only" claim is retired.
- Landing-page trust strip: "macOS Keychain" → "macOS Keychain ·
  Linux Secret Service".

### Notes
- Headless Linux (SSH, container, WSL) is still unsupported. The
  resolver emits an explicit "no Secret Service reachable" error
  so users know exactly what's wrong. The follow-up tiers
  (`LinuxPass`, `EncryptedFile`) are tracked in
  `specs/cross-platform-and-codex.md` §5.
- Windows (`WindowsCredential`) and the Codex adapter (workstreams
  B and C) are not in this release. The new `KeyStore` interface
  is the seam they will plug into — when they land, they'll be
  one file each behind the same resolver.

## [0.3.0] — 2026-05-23

### Added — Spend visibility (the second product, `specs/spend-visibility.md` Phases 1-3)

The "second product" lands. The dashboard's monthly-spend total is no
longer just what the user typed — for sync-enabled providers it's a
real number pulled from the provider's billing API, on demand, with a
clear "fetched" tag.

**Network-posture rule**, surfaced verbatim on the CLI, the dashboard,
the README, and the landing page:

> stm makes outbound network calls only when you click sync, only to
> the providers you've configured. No background activity, no
> telemetry, no phone-home. Ever.

Concretely:
- **`spend` SQLite table** keyed by `tool_id`, with `fetched_usd`,
  `fetched_at`, `source` (`fetched | error | manual`), and `last_error`.
  Additive migration — opens fine on existing v0.2.x DBs.
- **`SpendProvider` interface** (`src/providers/types.ts`) — pure
  functions over a usage credential; one outbound HTTP call each,
  with injectable `fetch` for testing.
- **OpenAI provider** (`src/providers/openai.ts`) — calls
  `GET /v1/organization/costs?start_time=&end_time=&bucket_width=1d`,
  sums every bucket's `amount.value`. Uses a separate admin key
  (`{{stm:openai:admin-key}}`); never the runtime API key.
- **Anthropic provider** (`src/providers/anthropic.ts`) — calls
  `GET /v1/organizations/cost_report?starting_at=&ending_at=`,
  defensively parses both direct-`amount` and `results[]`-style
  responses. Admin-key based; same separation.
- **Sync orchestrator** (`src/sync.ts`) — resolves the usage
  credential from the keychain, calls the provider, writes either
  `setSpend` on success or `markSpendError` on failure. **Never
  silently zeroes a previous good value on error** (spec §5 invariant
  — covered by a dedicated test).
- **`stm sync [provider]` CLI** — runs every registered provider or
  one named provider. Banner reminds the user of the network-posture
  rule on every invocation. `stm sync --list` enumerates registered
  providers.
- **Dashboard "Sync spend" button** in the header next to the monthly
  total. Three-state pill next to the number:
    - `FETCHED` (emerald)    — every tracked tool has a fetched number
    - `PARTIAL` (amber)      — some fetched, some self-reported
    - `SELF-REPORTED` (grey) — manual ledger only
  Each Subscriptions row gets a tag: `fetched` (emerald, with the
  fetched timestamp in the tooltip), `sync failed` (red, with the
  error message in the tooltip), or no tag (manual).
  A compact monospace sync-log appears under the Subscriptions table
  with one line per provider after a click.
- **Daemon endpoints** (auth + Host/Origin allowlist applies):
    - `GET  /api/spend`        — listSpend + breakdown + provider ids
    - `POST /api/spend/sync`   — `{provider?}` runs one or all
  The existing `GET /api/inventory` now also returns
  `monthlySpendBreakdown`, the `spend` rows, and the registered
  provider ids.
- **Catalog gains `supportsUsage` + `usageCredentialLabel`** fields.
  OpenAI and Anthropic now declare a second credential label
  (`admin-key`) and `supportsUsage: true`. Catalog ↔ providers
  invariant covered by a test.

### Changed
- `Store.monthlySpend()` now prefers `spend.fetched_usd` over
  `tools.monthly_cost` per tool. Users with zero `spend` rows see no
  behavior change — back-compat by construction.
- Landing page (`docs/index.html`): "Spend visibility" promoted out
  of the "next" column into the live "Today" column, with the
  network-posture sentence rendered next to it.
- README: new "Spend sync — network posture" section + `stm sync` in
  the CLI table.

### Notes
- Phase 4 of `specs/spend-visibility.md` (Stripe) is **deferred** —
  per the spec's own framing, your *own* Stripe-account revenue/spend
  is a different category from "AI API spend" and is better modeled
  as a separate "Stripe income" panel. Not built in this release.
- 22 new tests in `test/spend.test.ts` covering store CRUD,
  monthlySpend semantics, provider parsers (both OK and error
  branches), and the orchestrator's "preserve previous value on
  error" rule. Suite: 149 pass, 0 fail (was 127).

## [0.2.8] — 2026-05-23

### Added
- **`stm import` scope auto-suggest (`specs/session-and-project-scope.md`
  Phase 3)** — closes that spec end-to-end. When the dashboard runs an
  import, the request now carries the session's `cwd` (from the
  `?from=` query param that `stm dashboard` sets). The server picks the
  longest-prefix project for that `cwd` and:
    - **Project matched** → silently adds each newly-imported
      `(tool, label)` to that project's `project_scope`. A
      single-line toast on the dashboard confirms ("Scoped N keys to
      <project>"). Imports are *for* the current project; making the
      user re-tick every box afterwards was busywork.
    - **No project matched** → returns a `suggest-create` payload with
      the `cwd`, a suggested project name (the last path segment), and
      the imported `(tool, label)` list. The dashboard renders an
      inline banner under the import message with a **Create project**
      button — one click creates the project at the cwd and scopes
      all imported keys to it in one batch.
- `importSelected(selections, { cwd, dbPath? })` — new option object.
  `cwd` triggers the Phase 3 logic; `dbPath` is the existing `STM_DB`
  test seam promoted to the API signature for unit-test ergonomics.
- New result field `scopeUpdate: ScopeUpdate | undefined` on
  `importSelected`. Discriminated union: `kind: "added-to-existing"`
  carries `projectId / projectName / projectPath / addedToScope[]`;
  `kind: "suggest-create"` carries `cwd / suggestedName / imported[]`.

### Changed
- `POST /api/import/confirm` body now accepts an optional `cwd` field
  alongside `selections`. Existing callers that don't send `cwd` get
  the historical `{imported, errors}` shape — no regression.

### Notes
- This release closes `specs/session-and-project-scope.md` end-to-end
  (all three phases + §7 enforcement). The 3 remaining spec items on
  the public roadmap are `spend-visibility.md`,
  `cross-platform-and-codex.md`, and the deferred Phase 3 of
  `service-catalog-browser.md` (search/typeahead).
- Default behaviour for users without registered projects, or who
  open the dashboard manually (no `?from=`), is unchanged — the
  import flow is back-compat.

## [0.2.7] — 2026-05-22

### Added
- **Dashboard Projects card (`specs/session-and-project-scope.md`
  Phase 2)** — a new card under "API keys" lists every registered
  project as a row showing:
    - Name + canonical path
    - The in-scope `(tool, label)` pairs as click-to-copy placeholder
      pills (same UX as the API keys table)
    - An **Enforce** checkbox that toggles `enforce_scope` (was already
      wired into PreToolUse by v0.2.5; now toggle-able from the UI)
    - **Edit scope** → expands a checklist of every active key the
      user has stored; tick/untick to add/remove from this project's
      scope. Each toggle hits the API immediately — no save button.
    - **Remove** (with a confirm prompt).
  Below the list, an inline "Add a project" form (path + name).
- **Session signal (`?from=<cwd>`)** — when `stm dashboard` opens the
  browser it now appends `?from=<encoded cwd>` to the URL. The
  dashboard parses that, calls a new
  `GET /api/projects/match?cwd=` endpoint, and renders a small
  emerald-tinted banner at the top:
    - Matched project →
      "Session in **<name>** · N keys in scope · `<path>`" + an
      **Edit scope** button that expands that project's row.
    - No match →
      "Session in `<cwd>` · no project matches this path" + a
      **Create project from this path** button that pre-fills the
      Add-project form with the cwd and the last-segment name,
      scrolls + flashes the Projects card, and focuses the name
      field so the user can confirm.
- New daemon endpoints (auth + Host/Origin allowlist applies):
    - `GET /api/projects` — list + scope + enforce flag for every
      project, one fetch.
    - `POST /api/projects` — add (`{path, name}`).
    - `PATCH /api/projects/:id` — rename (`{name}`).
    - `DELETE /api/projects/:id` — drop project + cascade scope.
    - `POST /api/projects/:id/scope` — add `{tool, label}` to scope.
    - `DELETE /api/projects/:id/scope` — remove `{tool, label}` from
      scope.
    - `GET /api/projects/match?cwd=` — longest-prefix lookup; returns
      `{project, cwd}` with `cwd` normalized through the same path
      canonicalization the store applies on writes (so the round-trip
      via "Create project from this path" is idempotent).

### Changed
- `stm dashboard` (`openDashboard` in `daemon.ts`) now appends
  `&from=<encodeURIComponent(process.cwd())>` to the URL it `open`s.
  The token-bearing URL still never goes to stdout; the `?from` value
  is the same `cwd` the agent itself has, so it's nothing
  conversation-sensitive.

### Notes
- This release closes Phase 2 of `specs/session-and-project-scope.md`.
  Phase 3 (the `stm import` auto-suggest "create a scope from these
  imported keys" flow) is the last remaining piece of that spec.
- Default behaviour for users without any registered projects is
  unchanged: the session signal hides itself when no project matches
  AND the URL has no `?from`, and the Projects card just shows the
  empty-state nudge.

## [0.2.6] — 2026-05-22

### Added
- **Service catalog browser (`specs/service-catalog-browser.md` Phases 1–2)** —
  a discovery surface on the dashboard. New "Browse services" card sits
  above "Add keys" and lists every catalog entry as a categorized grid of
  tile buttons. Clicking a tile:
    1. Opens the provider's API-keys page in a new tab (plain
       `target="_blank" rel="noopener noreferrer"` — no tracking, no
       redirect, no UTM).
    2. Pre-selects that service in the Add keys dropdown so the right
       credential fields are already rendered when the user comes back.
    3. Smooth-scrolls the dashboard to the Add keys card and triggers a
       1.5-second emerald-outline flash so the user's eye finds the form.
- **Catalog grew from 36 to 50 services.** 14 net-new entries:
    - **Sales & outreach**: Apollo, Clay
    - **Social media**: Typefully, Postiz
    - **Dev tools**: Linear, Notion
    - **Email**: Brevo, Mailgun, Postmark
    - **Database**: PlanetScale
    - **Hosting**: Fly.io, DigitalOcean
    - **Payments**: Lemon Squeezy, Paddle
- New `category` and `url` fields on every `ServiceDef`. `category` is a
  closed `ServiceCategory` union (12 buckets — AI, database, hosting,
  auth, payments, email, comms, social, sales, search, monitoring, vcs).
  `url` is the provider's API-keys settings page (HEAD-checked at build
  time; signup root substituted with a `// FIXME` comment for any 404).
- New exports `CATEGORY_LABEL` (display names) and `CATEGORY_ORDER`
  (render order) drive the dashboard browser without baking strings into
  the HTML template.

### Changed
- Landing page `description` and trust strip now read **"50 services
  pre-configured"** (was 36). `docs/llms.txt` paragraph updated with the
  full provider list and a note about the browser card. JSON-LD
  `softwareVersion` bumped to 0.2.6.

### Notes
- No outbound network calls at runtime. Provider URLs are bundled into
  the catalog at build time; the dashboard never fetches anything from a
  provider. Matches the project's no-backend / no-phone-home posture.
- No tracking on outbound clicks. Plain `noopener noreferrer` so the
  provider sees a direct visit and `subscribetome.pro` never sees the
  hop.
- The existing Service dropdown stays exactly as before — power users
  who already know what they want skip the browser entirely. The
  browser is additive discovery.
- Phase 3 (search box + keyboard navigation) is deferred to v2.

## [0.2.5] — 2026-05-22

### Added
- **`when.project` policy predicate (Phase 3 of `specs/command-policy.md`)** —
  policy rules can now narrow to a specific project. The hook resolves the
  session's `cwd` via `Store.matchProject` (longest-prefix) and passes the
  project name into the policy engine; a rule's `when_project` glob matches
  that name. Empty project = no match → only `*` or null fires.
- **Per-project scope enforcement** — every project now carries a
  `enforce_scope` flag (0 = guidance-only, default; 1 = enforce). When ON,
  `PreToolUse` denies any substitution whose `(tool, label)` isn't in the
  project's `project_scope` rows. The deny is logged with `policy_id = NULL`
  and a reason starting `"scope enforcement:"` — distinguishable from a
  user-authored deny rule.
- New CLI:
    `stm policy add --when-project <glob>`     attach the new predicate
    `stm project enforce <path> <on|off>`      toggle scope enforcement
- `stm policy list` adds a Project column; `stm project list` adds an
  Enforce column; `stm project show` displays the enforcement state.
- New daemon endpoint: `POST /api/projects/:id/enforce {on: boolean}`.
  `POST /api/policies` now accepts an optional `whenProject` field.
  `POST /api/policies/test` accepts an optional `cwd` to simulate the
  project predicate firing inside a given directory.

### Changed
- SQLite schema: `policies.when_project TEXT` and
  `projects.enforce_scope INTEGER NOT NULL DEFAULT 0`. Both are additive,
  applied at `Store` construction via PRAGMA-introspected `ALTER TABLE` —
  idempotent and safe on existing DBs (opening the same DB twice is a
  no-op).
- `PolicyRule.when_project: string | null` and `PolicyContext.project:
  string` are now part of the engine surface. The `project` field defaults
  to `""` for callers that don't supply one, so existing rules with a null
  predicate behave identically to before.

### Security
- Load-bearing invariant from `specs/audit-log.md` §5 re-validated: every
  branch — including the synthetic scope-enforcement deny — writes the
  un-substituted command. A new test seeds two recognizable secrets,
  exercises the scope-enforcement path, and asserts no audit row contains
  either seeded value.

### Notes
- This release closes `specs/command-policy.md` end-to-end (all four
  phases) and fulfils `specs/session-and-project-scope.md` §7
  (enforcement toggle). Phase 2 of session-and-project-scope (dashboard
  Projects view + `?from=<cwd>`) is the next remaining piece.

## [0.2.4] — 2026-05-22

### Added
- **Per-project key scope (`specs/session-and-project-scope.md` Phase 1)** —
  multi-session, multi-project users can now register projects and scope
  specific `(tool, label)` pairs to each one. When a Claude Code session
  opens in a path that matches a registered project (longest-prefix wins),
  `SessionStart` appends a "PROJECT SCOPE" section to its guidance listing
  ONLY that project's keys — the model is told about the relevant
  placeholders for this work, not the global 30+ inventory.
- New SQLite tables: `projects (id, path UNIQUE, name, created_at)` and
  `project_scope (project_id, tool_id, label)` with `ON DELETE CASCADE`
  on both foreign keys. Path index for fast lookup.
- New `stm project` CLI subcommand suite:
    `stm project add <path> <name>`
    `stm project list`
    `stm project show <path>`
    `stm project scope <path> <tool>:<label>`
    `stm project unscope <path> <tool>:<label>`
    `stm project rename <path> <new-name>`
    `stm project remove <path>`
- Path normalization: `~` expands to home; trailing slashes stripped;
  `..` / `.` resolved.

### Changed
- `SessionStart` hook now parses its stdin payload (used to drain and
  discard) and reads `cwd`. Falls back to `process.cwd()` on malformed
  input. Behaviour for users without any registered projects is
  identical to before — adopting scope is opt-in.

### Notes
- Scope is **guidance only** in this release. The `PreToolUse` hook
  still substitutes any managed placeholder regardless of project.
  Enforcement is `command-policy.md` Phase 3 (the `when.project`
  predicate), now unblocked.

## [0.2.3] — 2026-05-22

### Added
- **Audit log CLI (Phase 2 of `specs/audit-log.md`)** — a complete
  `stm audit` subcommand surface:
  - `stm audit [--tail N] [--event <class>] [--tool <name>] [--since <dur>]`
    tails the log most-recent-first as a fixed-width table.
  - `stm audit prune --before <dur>` drops rows older than a friendly
    duration (5m / 1h / 7d).
  - `stm audit prune --keep <N>` keeps only the N most-recent rows.
  - `stm audit clear` (refuses without `--yes` in interactive
    terminals).
- **Audit log dashboard subview (Phase 3)** — a "Recent decisions"
  section on the existing Command policy card. Compact monospace
  table with colour-coded event badges (`policy.deny` red,
  `policy.warn` amber, `unresolved` amber, `substitute` emerald,
  `malformed` grey). Filters: event class dropdown + tool input.
  Refresh + Clear log buttons. Renders the un-substituted command
  every time — same load-bearing invariant as the storage layer.
- **Audit log daemon API (Phase 4)** — two new authenticated endpoints
  behind the existing token + Host/Origin allowlist:
    - `GET /api/audit?limit=&event=&tool=` (limit clamped to [1,500],
      bad event class → 400)
    - `POST /api/audit/clear`

### Changed
- `Store.listAudit` now accepts an optional `sinceISO` filter.
- `Store.pruneAudit({ beforeISO?, keepNewest? })` is the new pruning
  primitive used by both the CLI and the rolling-buffer.

### Notes
- This release closes `specs/audit-log.md` end-to-end (all four
  phases). It also fulfils Phase 4 of `specs/command-policy.md`,
  which was waiting on audit-log integration.

## [0.2.2] — 2026-05-21

### Added
- **Audit log (Phase 1)** — every `PreToolUse` decision now writes a
  forensic row to a new `audit_log` SQLite table. Five event classes:
  `substitute`, `policy.deny`, `policy.warn`, `unresolved`, `malformed`.
  Rolling 10,000-row cap (configurable via `STM_AUDIT_MAX`), with
  pruning batched inside the same insert transaction.

### Security
- Load-bearing invariant enforced by construction: **the audit log
  never contains a real key value**. Rows are written before
  substitution is applied to the command, with placeholders intact.
  An integration test seeds a recognizable key, exercises all five
  event-class branches, and asserts no audit row anywhere contains
  the seeded value. See `specs/audit-log.md` §5.
- `audit_log.policy_id` has `ON DELETE SET NULL` so removing a rule
  clears the linkage but preserves the historical record of when it
  fired. Tested.

### Notes
- Phase 2 (CLI: `stm audit`), Phase 3 (dashboard "Recent decisions"
  subview), and Phase 4 (`GET /api/audit` endpoint) are pending.
  Phase 1 closes the back-end half of `command-policy.md` Phase 4.

## [0.2.1] — 2026-05-21

### Added
- **Command policy in the dashboard (Phase 2)** — a new "Command policy"
  card in `/stm:dashboard` for managing rules visually:
  - A table of every rule (ordered ASC, with a Remove button per row).
  - An "Add rule" inline form: three glob inputs (key / command / agent),
    action select, order, reason, Add button.
  - A "Test a command" widget — paste a Bash command with `{{stm:…}}`
    placeholders, get back a coloured verdict card (deny / warn / allow),
    the matching rule id, the reason, and per-substitution detail.
- 4 new daemon endpoints behind the localhost-only auth token: `GET
  /api/policies`, `POST /api/policies`, `DELETE /api/policies/:id`, and
  `POST /api/policies/test`.

### Changed
- Dashboard token palette gains explicit `deny` / `warn` / `allow` badge
  variants; verdict card borders tint by severity.

## [0.2.0] — 2026-05-21

### Added
- **Command policy (Phase 1)** — `stm policy {list|add|remove|test}`. Rules
  are evaluated inside the `PreToolUse` hook **before** the keychain is
  consulted, so a deny rule prevents a key from ever being read for a
  rejected command. Predicates are glob patterns over `(key, command,
  agent)`; actions are `allow` / `deny` / `warn`; first-matching rule wins
  by `ordering` then `id`; per-substitution decisions collapse with
  severity `deny > warn > allow`. New `policies` table on the SQLite
  store. Default action when no rule matches is still `allow` (opt-in
  enforcement). Dashboard editor and project predicate land in later
  phases — see [`specs/command-policy.md`](./specs/command-policy.md).

## [0.1.9] — 2026-05-20

### Added
- **Parallel Web Systems** (parallel.ai) added to the dashboard catalog.
  Single `api-key` field. Landing-page trust strip now reads "36 services
  pre-configured".

## [0.1.8] — 2026-05-19

### Added
- **Custom fields** in the dashboard's "Add keys" form: after a service's
  standard fields, an "+ Add another field" button lets you store extra
  credentials a provider needs under your own label (e.g. a `jwt-secret` for
  Supabase). Each row is a label + value you can remove.

### Changed
- Maintainer contact updated to `abhinav@matterhorn.so`.

## [0.1.7] — 2026-05-19

### Changed
- Expanded the dashboard service catalog from 10 to **35 researched services** —
  AI/LLM providers (OpenAI, Anthropic, Gemini, Groq, Mistral, OpenRouter, fal,
  Replicate, ElevenLabs), databases (Supabase, Neon, MongoDB Atlas, Upstash,
  Firebase), hosting (Vercel, Netlify, Railway, Cloudflare, AWS), auth (Clerk,
  Auth0), Stripe, comms (Resend, SendGrid, Twilio, Slack, Telegram, Discord),
  Twitter/X, search (Tavily, Firecrawl, Exa), monitoring (Sentry, PostHog),
  GitHub. Each carries its real credential field names.

## [0.1.6] — 2026-05-19

### Added
- **Service catalog picker** in the dashboard: choose a service and the form
  lays out its standard credential fields (Supabase → service-role-key /
  anon-key / db-password; Twitter → its five tokens; etc.). Fill what you have,
  one click adds them all. "Other" keeps the free-form tool + label flow.
- `UserPromptSubmit` now also blocks a prompt containing any **secret stm
  manages, matched by exact value** — catches plain passwords with no key shape.

## [0.1.5] — 2026-05-19

### Added
- **SessionStart hook**: every Claude Code session is automatically taught how
  to use stm-managed keys — no `CLAUDE.md` or config edit required.

## [0.1.4] — 2026-05-19

### Changed
- Renamed the plugin `subscribetome` → **`stm`**. Slash commands are now
  `/stm:dashboard`, `/stm:inventory`, `/stm:import`, `/stm:revoke`. Install is
  `claude plugin install stm@subscribetome`.

### Fixed
- Keychain service name is now resolved per-call, not frozen at module load,
  so the test suite's seed process and its spawned hook subprocesses share one
  keychain service.

## [0.1.3] — 2026-05-19

### Added
- **Click-to-copy placeholders** in the dashboard, with a toast.
- **Editable subscriptions**: set or change a tool's plan, monthly cost, and
  renewal date directly in the dashboard, independent of adding a key.

## [0.1.2] — 2026-05-18

### Added
- Marketing landing page (`docs/index.html`, served via GitHub Pages).

### Changed
- Redesigned the dashboard with a three-layer design-token system.

## [0.1.1] — 2026-05-18

### Fixed
- Removed the `hooks` field from `plugin.json`: Claude Code auto-loads
  `hooks/hooks.json`, and declaring it twice caused a duplicate-hooks load
  failure that left the plugin unable to load.

## [0.1.0] — 2026-05-18

### Added
- Initial release. A Claude Code plugin: out-of-band key entry, macOS Keychain
  storage, and three hooks — `PreToolUse` (injects real keys into commands via
  placeholder substitution), `UserPromptSubmit` (blocks a raw key in chat),
  `PostToolUse` (flags a key leaked into output).
- The `stm` CLI, the localhost dashboard daemon, and `.env` import.

[0.3.1]: https://github.com/matterhornso/subscribetome/releases/tag/v0.3.1
[0.3.0]: https://github.com/matterhornso/subscribetome/releases/tag/v0.3.0
[0.2.8]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.8
[0.2.7]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.7
[0.2.6]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.6
[0.2.5]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.5
[0.2.4]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.4
[0.2.3]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.3
[0.2.2]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.2
[0.2.1]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.1
[0.2.0]: https://github.com/matterhornso/subscribetome/releases/tag/v0.2.0
[0.1.9]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.9
[0.1.8]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.8
[0.1.7]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.7
[0.1.6]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.6
[0.1.5]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.5
[0.1.4]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.4
[0.1.3]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.3
[0.1.2]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.2
[0.1.1]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.1
[0.1.0]: https://github.com/matterhornso/subscribetome/releases/tag/v0.1.0
