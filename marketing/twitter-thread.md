# Twitter / X — launch thread

Site: https://subscribetome.pro
GitHub: https://github.com/matterhornso/subscribetome

Tone: builder-to-builder, no buzzwords. Each tweet ≤ 270 chars to leave room
for quote-tweets. Thread reads top-to-bottom without needing the next reply.

---

## 1 / 7 — the hook

Your AI API key has no business being in your chat transcript.

But every time you paste it into Claude Code, that's exactly where it lives — forever.

I built **subscribetome** to fix this. Open source. macOS Keychain. Claude Code plugin.

→ https://subscribetome.pro

## 2 / 7 — the trick

Claude Code uses your key.
Claude Code never sees your key.

The chat only ever holds a placeholder: `{{stm:openai:default}}`

A PreToolUse hook swaps in your real key the instant a command runs — and stops there. Never the conversation.

## 3 / 7 — what ships

✓ 36 services pre-configured (OpenAI, Anthropic, Supabase, Stripe, Vercel, AWS, Twilio, Slack, …)
✓ Custom fields for anything not in the catalog
✓ Localhost dashboard. No backend. No telemetry. No phone-home.
✓ Pasted-secret guardrail
✓ Leaked-key alert

## 4 / 7 — install (the human path)

Two commands:

```
claude plugin marketplace add matterhornso/subscribetome
claude plugin install stm@subscribetome
```

Restart Claude Code, run `/stm:dashboard`, add your keys.

The keys never go through the chat — entry is deliberately out-of-band.

## 5 / 7 — install (the lazy path)

Paste this into Claude Code:

> Set up subscribetome for me using https://github.com/matterhornso/subscribetome

It reads the README, checks your machine, installs itself, and tells you to add your keys.

That's the whole onboarding.

## 6 / 7 — what's next

stm is the *security layer for AI-assisted coding*. v1 is keys. The roadmap:

→ Spend visibility (real usage from provider APIs, on-demand)
→ Command policy (allow / deny rules)
→ Linux, Windows, Codex, opencode, Cursor

Open issues if you want any of these sooner.

## 7 / 7 — links

Repo: https://github.com/matterhornso/subscribetome
Site: https://subscribetome.pro
MIT licensed. Built on Bun. Zero runtime dependencies.

If you try it and the install isn't dead simple — DM me. That's the bar.

---

## Notes on posting

- Pin the thread to the profile.
- The first tweet should include a single screenshot (the dashboard with keys
  redacted) or the transform-diagram from the landing page — whichever
  renders better on mobile X.
- Reply with a follow-up after the first 24h if anything breaks for early
  installers; thread the fix as tweet 8/8.
- Don't use the word "revolutionary" or "game-changing". If a tweet feels
  promotional, delete it.
