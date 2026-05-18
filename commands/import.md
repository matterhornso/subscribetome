---
description: Scan .env files for existing API keys to import into subscribetome
---

Run `stm import` in a Bash command. To scan a specific directory, pass it as an
argument: `stm import ~/projects`.

Show the user the candidate keys found. Then tell them to run
`/subscribetome:dashboard` and use the **Import** section to confirm, relabel,
and store the ones they want — the dashboard imports each key's value
server-side so it never passes through the chat.
