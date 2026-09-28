# Matterhorn selected secrets v1 — development contract

This additive local API is not yet a released or OS-accepted integration.
Existing bulk injection and broker routes retain their prior contracts.

All three new endpoints require the dashboard token in `x-stm-token`, a literal
`127.0.0.1:port` Host and no browser Origin or query string. Broker tokens cannot
use these endpoints. Responses are `Cache-Control: no-store`.

- GET `/api/integrations/v1/capabilities`: `{version:1, selectedResolution:true,
  revisionedWrites:true, revisionedResolution:true, backendId:string, backend:string}`. Backend describes configured storage,
  not an unlock guarantee.
- GET `/api/integrations/v1/keys`: `{version:1, keys:[{tool,label,status,updatedAt,revision}]}`.
  No secret resolution, keystore references, billing or token fields.
- POST `/api/integrations/v1/resolve`: body `{version:1, bindings:[{envName,tool,label}]}`;
  response `{version:1, values:{ENV_NAME:value}}`.
  Optional `includeRevisions:true` also returns `revisions:{ENV_NAME:revision}`.
  Each revision comes from the same inventory row whose keystore reference was
  read, not a separate list-before/after request. This is a per-key snapshot, not
  cross-key atomic rotation or revocation of existing process memory. A backend
  without snapshot support refuses this option rather than guessing revisions.
- POST `/api/integrations/v1/keys`: `{version:1,tool,label,value,expectedRevision}`.
  `expectedRevision:null` creates only if absent; a current opaque revision
  replaces only an active matching key. Returns metadata and
  `oldValueCleanupPending`, never values or storage references. Stale revisions,
  revoked keys and conflicting creates return 412. Invalid bodies return 400;
  storage failures return a fixed 503 response. Do not automatically retry writes.

An empty array returns no keys. Maximum 32 selected bindings, 32 KiB request,
16 KiB per value. POSIX aliases preserve exact casing; case-folding collisions,
reserved prefixes, process-control names, unknown/revoked keys and invalid
segments are rejected. The full selection is validated before values are read.
Keystore errors return fixed codes, never native errors or partial values.

Revisions hash random storage identity and state, not secret bytes. The inventory
schema and legacy key-list response are unchanged. Native rotation and revocation
also change the revision. Rotation uses compare-and-swap against the observed
storage reference and status, so another writer cannot be silently overwritten.
An inventory failure rolls back the new storage entry; old-entry deletion failure
is reported without claiming the old bytes were erased. Cross-store crash recovery
and real keystore acceptance remain separate gates.

References use STM's canonical tool/label identity. Rotation retains
that identity and affects future resolutions. Changing tool/label requires
explicit relinking. This API is NOT a scoped capability: a dashboard-authorized
caller can choose other keys. Matterhorn must enforce its own explicit binding,
consumer permission and host-only control-plane boundary.

Tests use an in-memory store. Real keychain/compiled daemon acceptance and
scoped integration credentials remain release gates. No real credentials have
been changed. No migration or brokered HTTP integration is introduced by this patch.

## Keystore compatibility

`backendId` is an additive machine-readable field on this unreleased v1 contract.
STM translates its existing exact implementation descriptions into
`macos-keychain`, `encrypted-file`, `linux-secret-service`, `linux-pass` or
`windows-credential`. Unknown/custom descriptions, including the resolver's
unsupported store, produce `unsupported` and the fixed label `Unsupported
keystore`; native failure reasons are not echoed. This lookup performs no
keystore read, write, unlock or probe. It does not claim OS acceptance.

Matterhorn's macOS-only pilot requires an explicit compatible ID and permits
`macos-keychain` or `encrypted-file`. It rejects missing/malformed IDs as an
incompatible daemon, and unknown/other-platform IDs as an unsupported keystore.
The display label alone cannot enable pairing. An already-paired backend change
is rechecked before bound reads/writes; rejection keeps metadata available and
never restores a plaintext credential. EncryptedFile is not labelled Keychain.

The contract fixtures advertise a macOS identity to test this handshake, but use
only injected in-memory keystores. Selected/lifecycle/cross-repository suites:
**28 passed / 141 assertions** after this addition, including a backend becoming
unsupported after pairing without another secret read. Run the three suites with
`MATTERHORN_STM_ADAPTER_PATH` pointing to the companion adapter as documented in
Matterhorn's worklog. Real keystore acceptance remains separately gated.
