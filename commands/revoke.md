---
description: Mark a subscribetome-managed API key as revoked
---

Ask the user which key to revoke — the tool and label. If they are unsure, run
`stm list` to show the available placeholders.

Then run `stm revoke <tool> <label>` in a Bash command.

Tell the user this sets a `revoked` status flag in subscribetome (the
PreToolUse hook will refuse to inject a revoked key). It does **not** call the
provider's API to rotate or delete the key — do that in the provider's own
dashboard.
