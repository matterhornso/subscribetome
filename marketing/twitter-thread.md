# Twitter / X — launch thread (Matterhorn team voice)

Site: https://subscribetome.pro
GitHub: https://github.com/matterhornso/subscribetome
Account: @matterhornso · Typefully social_set_id: 294242

Tone: builder-to-builder from the Matterhorn team. No buzzwords. Each tweet
self-contained enough that a screenshot of any one of them stands alone.

---

## 1 / 7 — the hook

Your API keys have no business living in your chat history.

But paste one into Claude Code and that's exactly where it stays — forever.

We at Matterhorn built subscribetome to fix that. Open source. macOS Keychain. Claude Code plugin.

→ https://subscribetome.pro

## 2 / 7 — the trick

How it works:

Claude Code *uses* your key.
Claude Code never *sees* your key.

The chat only ever holds a placeholder — `{{stm:openai:default}}`.

A PreToolUse hook swaps in the real key the instant a command runs, then stops there. Never the conversation.

## 3 / 7 — what ships

What ships in v1:

✓ 36 services pre-configured (OpenAI, Anthropic, Supabase, Stripe, Vercel, AWS, Twilio, Slack, …)
✓ Custom fields for anything not in the catalog
✓ Localhost dashboard. No backend. No telemetry. No phone-home.
✓ Pasted-secret guardrail
✓ Leaked-key alert

## 4 / 7 — install (the human path)

Install — two commands:

```
claude plugin marketplace add matterhornso/subscribetome
claude plugin install stm@subscribetome
```

Restart Claude Code, run `/stm:dashboard`, add your keys.

Keys never travel through the chat — entry is deliberately out-of-band.

## 5 / 7 — install (the lazy path)

Don't want to type? Paste this into Claude Code:

> Set up subscribetome for me using https://github.com/matterhornso/subscribetome

It reads our README, checks your machine, installs itself, and tells you to add your keys.

That's the whole onboarding.

## 6 / 7 — what's next

subscribetome is the first product in a bigger Matterhorn thesis: **a security layer for AI-assisted coding**.

What's next on our roadmap:
→ Spend visibility — real usage from provider APIs
→ Command policy — allow/deny at PreToolUse
→ Linux, Windows, Codex, opencode, Cursor

## 7 / 7 — links

Site → https://subscribetome.pro
Repo → https://github.com/matterhornso/subscribetome

Built on Bun. Zero runtime dependencies. MIT licensed.

If you try it and the install isn't dead simple, DM us. That's the bar we set ourselves.

— the Matterhorn team

---

## Posting notes

- Scheduled via Typefully MCP for **2026-05-20 14:00 UAE (10:00 UTC)** on the
  matterhornso account.
- Pin the thread to the profile after it goes live.
- Tweet 1 deserves a single screenshot — the transform-diagram from the
  landing page renders best on mobile.
- Reply to every quote-tweet and comment in the first 24h. The launch
  window is the only time the algorithm gives you free reach.
