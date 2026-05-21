# Show HN — subscribetome

Site: https://subscribetome.pro
GitHub: https://github.com/matterhornso/subscribetome

## When to post

Hacker News best windows (in order of expected reach):

1. **Tue / Wed, 9–11am US Eastern** — front-page candidacy is highest
   when most US engineers are starting the day.
2. **Mon, same window** — second-best, but riskier (weekend backlog).
3. Avoid Friday afternoon ET (graveyard) and the weekend (low traffic
   but also low signal).

After posting, **stay in the thread for the first 6–8 hours**. Reply to
every top-level comment with a one-line answer in the first hour. The
moderators ramp visibility based on healthy engagement and thoughtful
maker responses.

## Title (the single most load-bearing string)

```
Show HN: Subscribetome – Open-source API key manager for Claude Code (keys never touch chat)
```

Hacker News title rules I'm matching here:

- Starts with `Show HN:` exactly (capitalization matters; case-sensitive in some places).
- Project name has the first letter capitalized (HN's house style — lowercase brand names usually get auto-capitalized anyway).
- The parenthetical is the unique value-prop in one phrase, not a tagline.
- No emoji, no exclamation marks, no "I built". (HN downvotes any of these on sight.)

## URL field

Use the GitHub repo as the URL, NOT the landing page:

```
https://github.com/matterhornso/subscribetome
```

Why: HN audience is engineers. They prefer to land on source code, not
marketing copy. The README's first paragraph already states the value;
they get there with one click instead of two.

(If subscribetome.pro had genuine product-page content beyond a
marketing page, we'd use that instead. The repo wins here.)

## First comment from the maker — POST WITHIN 30 SECONDS

```
Hi HN — I'm building this at Matterhorn Labs and figured I'd share now
that v0.2 is in the marketplace.

The thing I kept doing: pasting an OpenAI key into Claude Code to "test
something quickly", then realising the key now lives in a conversation
transcript I can't fully scrub. Rotate, repeat, rotate, repeat.

subscribetome is one Claude Code hook (PreToolUse) and a localhost
dashboard. You add a key in the dashboard, it goes to your macOS
Keychain, and from chat you only ever refer to it as
`{{stm:openai:default}}`. The hook rewrites the shell command Claude
runs the instant before it runs, swapping the placeholder for the real
key. The model never sees the value; the transcript never holds it.

A few intentional decisions I'd be happy to argue about:

- No backend. None. The dashboard is your own machine on 127.0.0.1.
  I didn't want to be the custodian of anyone's keys.
- Out-of-band entry only. The plugin will block any prompt that
  contains a raw key — even one I manage, matched on exact value —
  before the model sees it. Feels weird the first time; it's the
  whole point.
- Honest about limits. The README's security model lists what it
  can't do (a command that prints its own arguments can leak the
  key it received; PostToolUse flags it but cannot un-leak it).

The roadmap and design docs are in `/specs` — cross-platform support,
real spend visibility, per-project key scope, command policy (allow/
deny rules), and an audit log. Happy to dig into any of them.

If anything breaks during install, ping me here or open an issue —
I'll respond same-day.

— Abhinav (matterhornso)
```

Length is right around 250 words, which is the sweet spot — long
enough to convey context, short enough that engineers actually read it.

## Questions to expect (have these answers ready)

| Likely question | One-line answer |
|---|---|
| "Why not just use direnv / .env / 1Password CLI?" | Those address storage. They don't address the chat transcript problem — the agent still ends up holding the value in conversation. stm closes that gap specifically. |
| "What if a command prints its own argv?" | PostToolUse flags it as a leak and tells you to rotate. README section "What it cannot do" calls this out explicitly. |
| "But ps will see the key while the command runs?" | True. Documented limitation. We keep the key out of the *conversation*, not out of the local process table. |
| "Bun? Why not Node?" | Bun has built-in SQLite and a faster startup — the PreToolUse hook is invoked synchronously before every Bash tool, so startup matters. Bun ~25ms vs Node ~85ms. |
| "Linux / Windows / Codex?" | macOS-only in v1. `specs/cross-platform-and-codex.md` explains the architecture and the load-bearing finding that Codex's PreToolUse hook can't do `updatedInput` — so we can't direct-port; need an env-injection adapter or MCP-wrapped tools instead. |
| "Did you read the Claude Code plugin docs / does it really work?" | Yes — `specs/command-policy.md` cites the exact hook payload shape (snake_case in, camelCase out, hookSpecificOutput.updatedInput.command for Bash). v0.2.1 in the marketplace today. |
| "How do I trust you not to phone home?" | The repo is the answer. Zero `dependencies` and zero `devDependencies` in `package.json`. The only outbound network code lives in (future) spend-visibility sync, and that ships behind an opt-in toggle. |

## Cross-post timing

Right after the Show HN goes live and gets its first 3-5 upvotes:

1. Drop the HN link in the launch tweet thread as the 8th tweet.
2. Cross-post to r/ClaudeAI 90 minutes after HN — wait until the HN
   thread has at least 5-10 comments so the Reddit post can link a
   "live conversation" instead of a graveyard. Title for Reddit:
   *"I built an open-source API key manager for Claude Code so keys
   never enter the chat (Show HN today)"*.
3. r/MacOS the next morning. Same rule (HN thread should be active).
4. Do NOT cross-post to r/programming the same day — they downvote
   self-promo hard. Wait a week and let someone else share it.

## What I'm NOT doing on launch day

- No DM blasts to friends asking for upvotes. HN detects vote rings
  and shadow-buries the post.
- No "we" in the maker comment (I used "I" + "Matterhorn Labs" once).
  HN responds to founders, not press releases.
- No screenshot of the dashboard in the first comment. The README
  has it; let people click.
- No claims I can't defend in the thread.
