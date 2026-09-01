# DESIGN.md — subscribetome marketing site

The design system for the marketing site under `docs/` (GitHub Pages,
subscribetome.pro). Inferred from the shipped `docs/index.html` and confirmed
during the 2026-09-01 landing-page design review. The dashboard UI
(`src/dashboard.ts`) shares the same spirit but is not governed by this file.

## Identity in one line

Dark, technical, quietly confident: an editorial serif voice for claims, a
terminal monospace voice for everything operational, one green accent that
means "safe / key / go".

## Tokens

Defined at `docs/index.html` `:root` — the source of truth. Never introduce a
color outside this set.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0a0b0d` | page background |
| `--bg-2` | `#101114` | cards, panels |
| `--bg-3` | `#15171b` | card headers (copybar) |
| `--ink` | `#ece9e2` | primary text (warm off-white) |
| `--ink-dim` | `#9a998f` | secondary text |
| `--ink-faint` | `#62625b` | tertiary text, separators |
| `--line` / `--line-2` | white @ 10% / 18% | hairline borders |
| `--acc` | `#3ddc97` | THE accent. keys, emphasis, brand |
| `--acc-bright` | `#74f0bc` | gradient top for filled elements |
| `--acc-deep` | `#0d2a1f` | accent hover fill |
| `--warn` | `#e8895e` | real-key/danger annotations only |
| `--ease` | `cubic-bezier(.2,.7,.2,1)` | all transitions |

Filled-accent gradient (logo mark, primary CTA):
`linear-gradient(150deg, var(--acc-bright), var(--acc) 55%, #1f8a63)` with ink
`#04130c`.

## Typography

Two faces, loaded from Google Fonts. No third face, ever.

- **Instrument Serif** (regular 400 only, roman + italic) — headlines and
  section titles. Italic + `--acc` marks the ONE emphasized phrase per
  headline. Never used for body or UI text.
- **IBM Plex Mono** — everything else: body, nav, buttons, labels, code.
  Body is 15px/1.65; small labels 12–13px, letter-spaced uppercase.

Headline scale uses `clamp()` (e.g. hero `clamp(40px,5.8vw,68px)`); never
fixed pixel headlines.

## Component vocabulary

Reuse these before inventing anything:

- **`.nav-cta`** — bordered pill link. Hover: accent border + `--acc-deep` fill.
- **`.nav-cta.primary`** — filled accent-gradient pill; the page's single
  primary action ("Get started →"). At most ONE per viewport.
- **`.copybox` / `.copybar` / `.copy-btn`** — terminal-style command card with
  a copy button. The canonical way to present anything paste-able.
- **`.strip`** — trust-marker row (`item / item / item`, accent `<i>` numbers).
  `.strip--hero` variant (more presence) for the under-hero position.
- **`.step`** — numbered card (accent-bordered number chip + h3 + copybox).
- **`.coming-card`** — roadmap teaser card with pulsing "Coming soon" tag.
- **`.rise .dN`** — entrance animation (fade + 20px rise, staggered
  `.05s–.44s`). Honors `prefers-reduced-motion` (disabled entirely).

## Layout rules

- Single centered column, `max-width:980px`, 32px side padding (`.bound`).
- Sticky translucent header (62px, blur backdrop). Anchor targets need
  `scroll-margin-top:62px`.
- Atmosphere: fixed grain overlay (3.5% opacity) + masked gridlines fading
  from the top. Do not add further decoration — if a section feels empty it
  needs better content.
- Responsive: grids collapse to one column ≤ ~760–780px; nav wraps at 520px
  with reduced brand/button sizing. Design each breakpoint intentionally.

## Voice & content rules

- Headline pattern: plain-serif claim + ONE italic-accent phrase
  ("…never seen by it.", "See it in action.").
- Body copy is mono and concrete; `<b>` for load-bearing phrases, sparingly.
- Security copy never shows a real key. Placeholder tokens render in accent
  (`.tok-ph`); fake "real" keys render in `--warn` and are always truncated
  (`sk-live-a3f9c1·········`).
- Trust strip content: 50 services / keys never touch the chat / platforms /
  agents / MIT. Update the numbers when the catalog grows.

## Hard don'ts

- No purple/blue gradients, icon-in-circle grids, decorative blobs, emoji.
- No second accent color; `--warn` is annotation, not a theme color.
- No new font faces or weights beyond the two loaded.
- No cards for decoration — a card must BE the interaction (copybox, step).
- Never bypass `prefers-reduced-motion`.
