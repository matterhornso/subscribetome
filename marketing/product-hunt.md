# Product Hunt launch — subscribetome

Site: https://subscribetome.pro
GitHub: https://github.com/matterhornso/subscribetome

---

## Name

**subscribetome**

## Tagline (60 char max — PH limit)

> The security layer for AI-assisted coding. Open source.

(Alt, if the above feels too abstract: *"Claude Code uses your API keys without ever seeing them."* — 60 chars exactly.)

## Topics

Developer Tools · Open Source · Artificial Intelligence · SaaS · Security

## Description (the main pitch — Product Hunt "Description" field)

You have API keys for a dozen AI tools. Every time you paste one into Claude
Code, it's logged in the conversation transcript forever. That's not what
those keys were designed for.

**subscribetome (stm)** keeps every key in your Mac's Keychain and feeds it
to Claude Code's commands automatically — so the AI can *use* your keys
without ever *seeing* them. The chat only ever holds a placeholder; the real
key is swapped in the instant a command runs, and stops there.

It is an open-source Claude Code plugin that runs entirely on your own
machine. No backend. No cloud. No telemetry. No sign-up. The dashboard is a
page your own Mac serves on `127.0.0.1`. There is no server because there is
no us.

**Today it ships:**

- 36 services pre-configured with their real credential field names
  (OpenAI, Anthropic, Supabase, Stripe, Vercel, AWS, Twilio, …) plus
  custom fields for anything not in the catalog
- Localhost dashboard for out-of-band key entry → Mac Keychain
- PreToolUse substitution into shell commands the agent runs
- Pasted-secret guardrail (a key you paste in chat is blocked before the
  model sees it)
- Leaked-key alert (a command that echoes its own input gets flagged so
  you can rotate)
- `stm` CLI: inventory, import, revoke, status

**On the roadmap:**

- Spend visibility — real usage pulled from provider APIs, on demand
- Command policy — allow / deny rules at the PreToolUse layer
- Linux, Windows, and other coding agents (Codex, opencode, Cursor)

**Install** (paste this into Claude Code):

> Set up subscribetome for me using https://github.com/matterhornso/subscribetome

Claude Code reads the README and does the rest. Adding keys is the one step
the user does by hand — by design, because keys must never go through the
chat.

Built on Bun. Zero runtime dependencies. MIT.

- 🌐 **Website:** https://subscribetome.pro
- 💻 **GitHub:** https://github.com/matterhornso/subscribetome

## First comment from the maker (post this immediately after launch)

Hey Product Hunt 👋

I built subscribetome because I kept doing the same dumb thing: pasting an
OpenAI key into Claude Code to "test something quickly", and then realizing
the key now lives in a conversation transcript that I can't fully scrub.
Rotate, repeat, rotate, repeat.

The core trick is one Claude Code hook: `PreToolUse` lets a plugin rewrite
a shell command the instant before it runs. So the model writes
`Authorization: Bearer {{stm:openai:default}}`, and the actual `curl` that
executes carries the real `sk-…`. The model never sees it. The transcript
never holds it.

A few intentional decisions:

1. **No backend.** None. The dashboard is your own machine serving on
   `127.0.0.1`. I don't want to be a target. There's nothing for me to be
   the custodian of.
2. **Out-of-band entry.** You add keys in the dashboard, not in the chat.
   The plugin will *refuse* to accept a pasted key. That feels weird at
   first; it's the whole point.
3. **Honest about limits.** The README's security model lists what stm
   can't do (a command that prints its own arguments can still leak;
   PostToolUse flags it but cannot un-leak it). I'd rather tell you than
   have you find out.

The roadmap is real and open — there's a `specs/` folder in the repo with
the design docs for spend visibility (the next product), cross-platform
support, and per-project key scope. Open issues if you'd like one of these
sooner.

If anything breaks during install, ping me here or open an issue and I'll
respond same-day for the launch window.

- 🌐 https://subscribetome.pro
- 💻 https://github.com/matterhornso/subscribetome

Thanks for taking a look 🙏

## Hunter / Maker checklist before posting

- [ ] Schedule the launch for 12:01am PT on a Tuesday or Wednesday
- [ ] Gallery: 1) the landing-page hero, 2) the transform diagram,
  3) the localhost dashboard with keys redacted, 4) the install snippet
- [ ] The first comment (above) goes up within 60 seconds of launch
- [ ] Reply to every comment in the first 24h, even one-word ones
- [ ] Have the GitHub issue template ready — first launch traffic always
  finds one edge case
- [ ] Cross-post the thread on X, Hacker News (Show HN), and r/ClaudeAI
  within the first 4 hours
