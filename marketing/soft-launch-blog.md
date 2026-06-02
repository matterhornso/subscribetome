# Your AI coding agent should never see your API keys. Now it doesn't.

*Introducing subscribetome — a soft launch, and an invitation to break it.*

---

There's a small, quiet moment of dread every time you wire an API key into an AI coding session.

You paste `sk-proj-…` into the chat so the agent can call OpenAI. Or you tell it to "just put the Stripe key in the `.env`." And the second you hit enter, that key is sitting in a transcript. On a server. In a log. In a context window that might get summarized, cached, replayed, or — if you're using a hosted agent — shipped somewhere you'll never audit.

You *know* it's fine, probably. But you also know you just turned a secret into plaintext history. And you can't un-send it.

**subscribetome makes that moment go away.**

The model writes a placeholder. The real key gets swapped in at the *instant* the command runs — after the model is done thinking, outside the transcript. The agent gets the work done. It just never sees the secret.

```
You ask:    "Use my OpenAI key to call chat completions with 'hello'"
Model runs: curl ... -H "Authorization: Bearer {{stm:openai:default}}"
What runs:  curl ... -H "Authorization: Bearer sk-proj-REAL-KEY"
```

The model only ever saw `{{stm:openai:default}}`. The keychain handed over the real value at the last possible millisecond, to the shell, not to the chat. There is no point at which your key is text the model can read.

That's the whole idea. Here's what it looks like.

---

## Add a key in five seconds — it goes straight to your OS keychain

Run `/stm:dashboard` and a local page opens. Pick a service, paste the key, done. The value goes directly into your **macOS Keychain** (Secret Service / Credential Manager on Linux & Windows) — it never passes through Claude Code, never hits a config file, never leaves your machine.

![The subscribetome dashboard — add a key, scoped to your service, with optional plan + monthly cost](../docs/screenshots/dashboard.png)

Notice the little details that make this feel less like a vault and more like a tool you'd actually keep open:

- It knows OpenAI takes an `api-key` *and* an `admin-key`, and lays out both fields for you.
- You can tag the key with a **plan and monthly cost** — because the thing you're protecting is also the thing you're paying for (more on that below).
- The footer says it plainly: *"You and the model only ever see each `{{stm:tool:label}}` placeholder."* That's the contract.

And the top bar shows you exactly which agents are wired and which keystore is live — `MACOS KEYCHAIN`, `monthly spend $0.00`, ready.

---

## 50 services, pre-configured, one click to wire up

Nobody remembers the exact field names every provider wants. So we shipped a catalog of **50 services** — pick a tile and it opens that provider's API-keys page in a new tab *and* pre-fills the add-key form with the right fields.

![Browse services — 50 pre-configured providers across AI, database, hosting, auth, and payments](../docs/screenshots/browse-services.png)

OpenAI, Anthropic, Gemini, Groq, Mistral, fal.ai, Replicate, ElevenLabs… then Supabase, Neon, Mongo, Upstash… Vercel, Netlify, Railway, Cloudflare, AWS… Clerk, Auth0, Stripe, Lemon Squeezy, Paddle. The keys you actually juggle in a real project, in one grid.

---

## Scope keys to projects, so the agent only knows what it needs

Here's a sharper edge most secret managers miss: your agent shouldn't have access to *every* key just because it's in *a* session. subscribetome lets you register a project (a path + a name) and scope specific keys to it.

![Projects tab — per-project key scope with longest-prefix cwd matching and an Enforce toggle](../docs/screenshots/projects-tab.png)

When a session opens inside that directory, the SessionStart hook tells Claude Code about **only the keys scoped to that project** — matched by longest-prefix on your working directory. Flip **Enforce** on and the PreToolUse hook will outright *refuse* an out-of-scope substitution. Your client-project session physically cannot reach for your personal Stripe key. Least privilege, for AI agents, with a toggle.

---

## A policy engine and a forensic audit log — because you'll want the receipts

You can write allow / deny / warn rules that evaluate at PreToolUse, *before* the keychain is ever read. Block a key on a dangerous command shape. Deny a specific agent. Set a default-deny catch-all. Strictest verdict wins (`deny > warn > allow`).

![Policy & audit tab — command policy rules, a command tester, and a forensic decision log that never holds a real key value](../docs/screenshots/policy-tab.png)

And every decision the hook makes gets logged — **what** it did, to **which** placeholder, **when** — in a forensic trail that, by design, *never holds a real key value*. There's even a "test a command" box so you can dry-run `echo {{stm:openai:default}}` and watch the policy engine reason about it before you trust it for real.

This is the part that turns "neat trick" into "thing I'm comfortable running on my actual secrets."

---

## Oh — and it watches your spend, too

Once a key is in, subscribetome can fetch **live month-to-date spend** straight from the provider (OpenAI and Anthropic today) — outbound only, on your explicit click, never in the background. Those optional plan + cost fields on each key roll up into a single monthly-spend number in the header.

It turns out "the place I keep my AI keys" and "the place I find out my AI keys cost me $340 this month" want to be the same place. So they are.

---

## What this *is* — and what it isn't (yet)

This is a **soft launch**. I want to be straight with you about the edges.

**Verified and solid:** macOS Keychain + Claude Code is the path I've lived in every day building this. Keys-never-touch-chat, the hooks, the placeholder injection, the policy engine, the audit log — **391 tests, all green**, exercised on real hardware.

**Built, but needs your hardware:** Linux (Secret Service / `pass` / encrypted-file) and Windows Credential Manager backends are shipped and smoke-tested against their interfaces — but they haven't been run end-to-end on a real GNOME desktop or a real Windows box *by me*. Same for the Codex adapters. The [`FIELD_VERIFICATION.md`](https://github.com/matterhornso/subscribetome/blob/main/FIELD_VERIFICATION.md) checklist is exactly for this: if you're on Linux or Windows, you're the person who can turn a ⏳ into a ✅. File an issue with your `stm doctor` output and you'll have shaped v1.

**Non-goals, on purpose:** no cloud, no sync, no telemetry, no team server. subscribetome stays local. The reason there's no "users like you spent…" dashboard is the same reason your keys are safe: nothing phones home, ever.

---

## Try it (macOS, two minutes)

Paste this into Claude Code:

> Set up subscribetome for me using https://github.com/matterhornso/subscribetome

Quit and reopen Claude Code, run `/stm:dashboard`, add a key. Then ask the agent to use it — and watch your transcript stay clean.

It's **free**, **MIT-licensed**, and **zero-telemetry**. The whole thing is on [GitHub](https://github.com/matterhornso/subscribetome).

If you're the kind of person who's ever winced pasting a key into a chat box — this is for you. Go break it, then tell me where it bends.

→ **[subscribetome.pro](https://subscribetome.pro)**
