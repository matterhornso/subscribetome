# tests-ui — Playwright dashboard suite

End-to-end browser tests that drive a sandbox stm daemon. Run alongside
`bun test` (unit) in CI. Currently 18 assertions covering security
posture, tab navigation, projects (incl. the Enforce-toggle layout fix),
add-key flow, browse-services collapse, and copy-to-clipboard.

## Run locally

One-time prereq: download the Chromium browser Playwright drives.

```
bunx --bun playwright install chromium
```

Then run the suite from the repo root:

```
bun run tests-ui/run.mjs
```

Expected output:

```
=== setting up sandbox
=== Playwright UI suite
HTTP / security posture:
  PASS  GET /api/health unauthed → 200
  PASS  GET /api/inventory unauthed → 401
  PASS  GET /api/inventory token → 200
  PASS  DNS rebind defense (bogus Host) → 403
Browser / UX:
  PASS  Initial tab = Keys
  PASS  Sync button label = 'Fetch live spend'
  ...
=== 18 / 18 passed
=== teardown
```

## Sandboxing

The runner is hermetic — it does NOT touch your real `~/.subscribetome/`
state.

| Layer | Sandbox value |
|---|---|
| Inventory DB | `/tmp/stm-ui.sqlite` |
| Keystore service | `subscribetome-ui-test` (separate from the real `subscribetome` service) |
| Dashboard daemon | A fresh one on a free port, killed at teardown |

Setup seeds deterministic state (6 keys, 1 revoked, 1 project "Acme App",
1 policy rule). Teardown wipes the keystore entries via
`/usr/bin/security delete-generic-password`, removes the temp DB, and
stops the daemon. If the runner exits abnormally mid-suite, re-run it —
setup begins with `cli stop` and a clean sweep, so leftover state is
fine.

If you had your own dashboard open when you started the suite, run
`stm dashboard` again afterward to get a fresh URL — the suite's
`stm stop` call in setup also stops yours.

## Visual baselines

The suite saves a full-page screenshot of each tab to `/tmp/stm-ui-test-*.png`
during the run. Useful for eyeballing what the dashboard actually renders.
In CI, these screenshots are uploaded as an artifact ONLY if the run fails
(see `.github/workflows/test.yml`).

## What's NOT covered (yet)

- Codex Option 1 launcher (no GUI surface)
- Codex Option 2 MCP server (covered by `test/codex-mcp.test.ts` already)
- Real provider API responses (`stm sync` against OpenAI / Anthropic)
- Windows Credential Manager FFI (would need a Windows runner)
- Linux Pass tier 2 + EncryptedFile tier 3 (would need a Linux runner with
  `pass` + GPG configured)

The Linux + Windows backends are unit-tested via injected fakes and are
covered in `FIELD_VERIFICATION.md` for real-hardware verification.

## How CI consumes this

See `.github/workflows/test.yml`. The `ui-macos` job:
1. Caches the Playwright browser download keyed by Playwright version
2. Installs Chromium
3. Runs `bun run tests-ui/run.mjs`
4. On failure, uploads `/tmp/stm-ui-test-*.png` as an artifact for triage
