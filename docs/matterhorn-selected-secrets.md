# Matterhorn selected secrets v1 — development contract

This additive local API is not yet a released or OS-accepted integration.
Existing bulk injection and broker routes retain their prior contracts.

All three new endpoints require the dashboard token in `x-stm-token`, a literal
`127.0.0.1:port` Host and no browser Origin or query string. Broker tokens cannot
use these endpoints. Responses are `Cache-Control: no-store`.

- GET `/api/integrations/v1/capabilities`: `{version:1, selectedResolution:true,
  backend:string}`. Backend describes configured storage, not an unlock guarantee.
- GET `/api/integrations/v1/keys`: `{version:1, keys:[{tool,label,status,updatedAt}]}`.
  No secret resolution, keystore references, billing or token fields.
- POST `/api/integrations/v1/resolve`: body `{version:1, bindings:[{envName,tool,label}]}`;
  response `{version:1, values:{ENV_NAME:value}}`.

An empty array returns no keys. Maximum 32 selected bindings, 32 KiB request,
16 KiB per value. POSIX aliases preserve exact casing; case-folding collisions,
reserved prefixes, process-control names, unknown/revoked keys and invalid
segments are rejected. The full selection is validated before values are read.
Keystore errors return fixed codes, never native errors or partial values.

References currently use STM's canonical tool/label identity. Rotation retains
that identity and affects future resolutions. Changing tool/label requires
explicit relinking. This API is NOT a scoped capability: a dashboard-authorized
caller can choose other keys. Matterhorn must enforce its own explicit binding,
consumer permission and host-only control-plane boundary.

Tests use an in-memory store. Real keychain/compiled daemon acceptance and
scoped integration credentials remain release gates. No secret-write, replacement,
migration or brokered HTTP integration is introduced by this patch.
