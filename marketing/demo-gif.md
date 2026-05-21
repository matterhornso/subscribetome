# Launch demo gif — 20-second script

The launch tweet's first card will land 3-5× more reach with a video.
This is the exact sequence to record. **The recording must never have a
real key on screen** — use the test key shape `sk-DEMO-…` everywhere.

Total length: target **18-22 seconds**, looping. Twitter/X plays
videos muted by default, so the demo has to read without audio.

## The 5 shots (in order)

```
0:00 ── 0:03   The problem
   A Claude Code terminal. User types:
     "use my openai key sk-DEMOnotreal1234 to summarize this article"
   The screen shows it being typed; the moment Enter is hit, stm's
   block message flashes in red over the prompt:
     "Blocked — keys must never go through the chat"
   Hold for ~1s on the block.

0:03 ── 0:06   The fix is one step
   Cut to the terminal. User types:
     /stm:dashboard
   Browser opens to localhost dashboard. ~1.5s on the dashboard view.

0:06 ── 0:11   Add a key out of band
   In the dashboard:
     - Service dropdown: OpenAI
     - Paste field receives "sk-DEMOnotreal9876"
     - Click "Add"
     - Toast: "Added {{stm:openai:default}}"
   The placeholder is highlighted briefly so the eye reads it.

0:11 ── 0:16   Use it in chat
   Cut back to Claude Code. User types:
     "summarize this article with my openai key"
   Claude responds (fast-forward overlay) by running:
     curl -H "Authorization: Bearer {{stm:openai:default}}" https://api…
   The transcript shows ONLY the placeholder. Highlight that.

0:16 ── 0:20   The reveal
   Bottom of screen overlay: "the real key never enters the chat"
   Fade to subscribetome.pro card.
```

## Recording mechanics

- Tool: **kap** (macOS, free, gif/mp4 export) or **CleanShot X**.
- Resolution: 1080p source, exported at 720p — Twitter/X compresses
  aggressively, smaller is fine.
- Frame rate: 24fps is enough for terminal capture; 30fps if you want
  smoother browser scrolling.
- Format: **mp4** for Twitter (NOT gif — better compression, looping
  is automatic, audio is muted by default). LinkedIn and Bluesky also
  prefer mp4.
- Filename: `subscribetome-demo.mp4` (kebab-case, descriptive).
- Captions: hardcode them in the video. Twitter's auto-captions are
  unreliable for terminal text.

## Set dressing

- Use the system font, dark mode terminal (matches the landing page).
- Clear `~/.subscribetome/db.sqlite` before recording so the dashboard
  is empty at the start.
- Two terminals side-by-side OR a single terminal with a clean cut to
  the dashboard. Side-by-side reads tighter at small sizes.
- Hide the menu bar (CMD+OPT+H in the terminal).
- Mouse cursor: leave it visible — it's a teach-by-doing video.

## What to NOT include

- Real key values. Use `sk-DEMO…` everywhere.
- Long pauses. Cut anything over 0.8s with no movement.
- Voiceover. The demo reads in three seconds without audio.
- A "subscribe!" CTA at the end. The brand card is enough.
- Emoji captions ("🔒 secure!"). The pitch lands stronger without
  exclamation marks.

## Where it gets used

| Surface | Format |
|---|---|
| Tweet 1 of the launch thread | mp4 attached, plays muted, loops |
| LinkedIn post (if we do one) | same mp4, no changes |
| README at the top, replacing the static screenshot | use the same mp4 + a poster image (one frame of "the fix") |
| Product Hunt gallery (when we do PH) | one of the 4 gallery slots |

## Acceptable substitute if you can't record today

A still 1200×630 image of the dashboard + the placeholder in a code
block is what's currently being used. The video will roughly **3×**
the engagement based on Twitter benchmarks for dev-tool launches. If
recording slips, ship the launch with the still and add the video
within 48 hours as a quote-tweet to the original.
