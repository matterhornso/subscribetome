# LinkedIn — launch post (draft, NOT posted)

Site: https://subscribetome.pro
GitHub: https://github.com/matterhornso/subscribetome
Voice: Abhinav, founder (Matterhorn Labs). First person, professional-but-plain, honest about limits.
Status referenced: v1.1 stable (1.1.1) · macOS + Claude Code · MIT · zero runtime deps.

> This is a **draft for you to post from your own LinkedIn** — nothing has been published.
> Pick the primary or the short version, tweak the voice to yours, and post it yourself.
> No version number in the body on purpose (it's feed noise) — just confirm 1.1.1 is
> published before posting so the repo matches what people click.

---

## Primary post (~230 words)

Your API keys have no business living in your AI chat history.

But paste one into an AI coding agent to "quickly test something," and that's exactly where it ends up — sitting in a transcript you can't fully scrub. So you rotate the key. Then you do it again next week.

I got tired of that loop, so I built **subscribetome** — an open-source key manager for Claude Code. It's out now.

The idea is simple: the agent *uses* your key without ever *seeing* it.

→ You add a key once, in a local dashboard. It goes straight to your macOS Keychain.
→ In chat, you only ever refer to it as a placeholder like `{{stm:openai:default}}`.
→ A PreToolUse hook swaps in the real key the instant a command runs — and stops there. The model never sees the value; the transcript never holds it.

No backend. No telemetry. Runs entirely on 127.0.0.1. 50 services pre-configured. Zero runtime dependencies. MIT licensed.

I also kept it honest about what it *can't* do — the security model spells out the edge cases (a command that echoes its own arguments can still leak the key it was handed; the tool flags it, but can't un-leak it).

It's scoped to macOS + Claude Code for now. If you live in an AI coding agent all day, I'd love your eyes on it.

⭐ Repo: https://github.com/matterhornso/subscribetome

#OpenSource #DeveloperTools #AI #Security #ClaudeCode

---

## Short version (~90 words)

Your API keys shouldn't live in your AI chat history — but paste one into a coding agent and that's where it stays.

I built **subscribetome** to fix that: add a key once, it goes to your macOS Keychain, and in chat you only ever see a placeholder like `{{stm:openai:default}}`. A hook swaps in the real key the instant a command runs. The model never sees it; the transcript never holds it.

Open source, local-only, no telemetry. Out now for Claude Code on macOS.

⭐ https://github.com/matterhornso/subscribetome

#OpenSource #AI #DeveloperTools #Security

---

## Optional "we take security seriously" line

If you want to signal active maintenance (a genuine strength for a security tool),
drop this into the honesty paragraph of the primary post, right after the
"can't un-leak it" sentence:

> When an internal security audit turned up a matching-logic gap in the command-policy
> rules — a deny rule that could be skipped on a multi-line command — it shipped a fix
> the same week, in 1.1.1.

Trade-off: it reads as confidence and "this is maintained," but it also raises a bug at
launch. For a security-audience post I'd include it; for a broad-reach post I'd cut it.
Your call — the default body above leaves it out.

---

## Posting notes

- **Post from Abhinav's personal profile**, not a company page — founder posts get more organic reach on LinkedIn.
- LinkedIn compresses links in-feed; the GitHub URL is fine inline. Consider putting the link in the **first comment** instead of the body (LinkedIn's algorithm historically favors posts without outbound links in the body) and replacing it in the post with "link in comments."
- A short **demo GIF or the dashboard screenshot** (see `marketing/demo-gif.md`) as the post image roughly doubles dwell time. The transform diagram from the landing page reads well.
- **Confirm the GitHub social preview card is uploaded** (Settings → General → Social preview) before posting — the link unfurl in-feed is the first thing people see.
- Best windows: **Tue–Thu, 8–10am in your audience's timezone.**
- Reply to every comment in the first few hours — early engagement drives distribution.
- Keep claims defensible; the repo is public and people will click. All facts above match stable **v1.1.1** (macOS + Claude Code; Codex/Linux/Windows are experimental).
