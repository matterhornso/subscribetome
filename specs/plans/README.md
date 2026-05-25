# Plans

Build-ready execution plans for upcoming releases. Each plan is
written to be handed to a build session (autonomous or human) and
executed without further design work — file lists, test cases,
version targets, risks, and definition-of-done.

A plan is NOT a spec. The spec (under `specs/`) is the design
contract and roadmap. A plan is the *next ship of that contract*
broken down to the level of "here are the files to edit".

Once a plan ships, its parent spec's `Status:` line is updated to
mark the phase done, and the plan can be deleted or archived.

## Active plans

| Version | Plan | Spec parent | Status |
|---|---|---|---|
| ~~v0.5.0~~ | [`v0.5-windows-backend.md`](./v0.5-windows-backend.md) — Windows Credential Manager backend via Bun FFI | [cross-platform-and-codex.md](../cross-platform-and-codex.md) §5 (Windows row) | **Shipped 2026-05-25** |
| **v0.6.0** | [`v0.6-linux-headless.md`](./v0.6-linux-headless.md) — Linux headless tiers 2 + 3 (LinuxPass + EncryptedFile) | [cross-platform-and-codex.md](../cross-platform-and-codex.md) §5 (Linux row, tiered fallback) | Planned |

v0.5.0 plan is kept in this folder as a reference for the
implementation pattern (KeyStore backend + injected FFI surface +
resolver wiring + scripted tests against a recording fake) — the
next platform backend (or anyone curious about the v0.5 approach)
can use it as a worked example. v0.6.0 is the next active build.
