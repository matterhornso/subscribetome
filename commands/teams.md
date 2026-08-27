---
description: Create an STM team or join one, guided end-to-end via stm teams quickstart
---

Ask the user: are they **creating** a new team (they're the first member / admin
of an `stm teams serve` instance), or **joining** a team someone else already
created?

Never ask for or handle a real API key here — this command only sets up team
membership. Adding keys still happens via `/stm:dashboard`.

## Creating a team (admin)

Ask the user for: the team server URL, the admin token they configured for
that `stm teams serve` instance (**not** a value stm generates — the person
running the server set it via `STM_TEAM_ADMIN_TOKEN`), and a team name.

Run this in a Bash command, passing the admin token via env var, not `--admin`
— an argv value is visible to `ps` and shell history:

```
STM_TEAM_ADMIN_TOKEN=<their-token> stm teams quickstart create --server <url> --name <name>
```

The output includes a ready-to-run invite block:
`stm teams quickstart join --server ... --token ... --fingerprint ...`

**Show that exact block to the user and tell them to send it to the new
teammate over a channel they already trust** (Slack DM, Signal, in person —
never a public channel or an issue tracker). This is the one required human
step in the whole flow: the fingerprint in that block is what stops a
malicious or compromised server from swapping in a team key it controls
instead of the real one. Do not try to relay it yourself through any tool —
only the user should hand it off, and only over a channel *they* trust.

When the teammate later sends back their **member-id** (a short string their
`join` step prints), run:

```
stm teams enroll <member-id>
```

Then tell the user to tell the teammate to run `stm teams quickstart finish`.

## Joining a team (new member)

Ask the user to paste the invite block their admin sent them (server, token,
fingerprint), then run it verbatim in a Bash command:

```
stm teams quickstart join --server <url> --token <token> --fingerprint <fp>
```

This prints a **member-id**. Show it to the user and tell them to send it to
whoever invited them, over the same trusted channel — this is the second and
last required human step.

Once the admin confirms they've run `stm teams enroll <member-id>`, run:

```
stm teams quickstart finish
```

## After either side is done

Tell the user they're enrolled:
- Share a key with the team: `stm teams share <tool>:<label>` then `stm teams push`.
- Pull keys others have shared: `stm teams pull`.
- See members + the signed usage log: `/stm:dashboard` → Teams tab.

**Never suggest `--unverified`.** If `quickstart accept` or `quickstart finish`
refuses because a fingerprint is missing, that means the out-of-band relay
above hasn't happened yet — do it, don't bypass it. The fingerprint check is
the only thing standing between this flow and a server-side MITM.
