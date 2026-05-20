# TODOS

Deferred scope for subscribetome. v1 is a go-forward system of record for a
solo developer on macOS; everything below is v1.5+.

## Managed-manager import (op / doppler / infisical)

v1 import covers `.env` files only. Importing from a managed secrets manager by
*copying* the value duplicates the secret and goes stale when the manager
rotates it. v1.5 should integrate by **pointer** — store a reference and
re-fetch the live value at injection time inside the PreToolUse hook.

## Provider-side key rotation

v1 `revoke` is a metadata flag. Real rotation — calling a provider's API to
issue a new key and revoke the old one — is provider-specific surface area.
Deferred until there is a concrete provider to support first.

## Audit log

A local, append-only record of which key (tool + label) each `PreToolUse`
substitution served, with timestamp and the calling tool — so after a leak
alert the user can answer "which command actually used this key?" without
guessing. SQLite table; visible in the dashboard, filterable by tool. Not on
the public roadmap card; lives here.

## Retroactive subscription discovery

v1 does not find already-forgotten subscriptions. Receipt / transaction
scanning to surface the existing forgotten spend is v1.5.

## PostToolUse blocking UX

PostToolUse blocks a tool result that contains a key, which interrupts the
model's work. Measure how often it fires in real use; consider a
user-configurable mode (block vs warn-only).

## Linux / Windows keychain backends

v1 stores keys in the macOS Keychain via `security(1)`. Add Secret Service
(Linux) and Credential Manager (Windows) backends.

## Keychain write without argv exposure

`security add-generic-password -w <value>` passes the secret as an argv
element, briefly visible to a local `ps`. v1.5: call the macOS Security
framework directly (Bun FFI) to close that window.

## Non-Claude-Code agents

v1 targets Claude Code — it has the hook system and `PreToolUse updatedInput`.
Equivalent capability in Codex / Claude Cowork is unverified.
