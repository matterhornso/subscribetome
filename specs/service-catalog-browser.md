# Spec — Service catalog browser

**Status:** Draft · **Target:** v0.3 · **Last updated:** 2026-05-22

> "List all the common platforms that people use with Claude Code on a
> separate section, grouped by category. Click a service → open its API-key
> page in a new tab AND pre-arm the Add keys form with that service ready
> to go."

A discovery surface on the dashboard. Today's "Add keys" form has a
dropdown that requires the user to already *know* which provider they
want. This spec turns the dashboard into something a Claude Code user
opens for **ideas**, not just key entry — a categorized browser of every
service stm knows about, with a one-click jump to "go get your key, come
back, paste it in".

## 1. Goal

Make stm answer the question a new user has but doesn't ask out loud:
*"What can I actually do with this thing?"*

Concretely:

- A new section on the dashboard, **above** the existing "Add keys"
  form, listing every catalog service grouped by category.
- Each service is a tile. Clicking a tile:
  1. Opens the provider's API-keys (or signup) page **in a new tab**.
  2. Scrolls the dashboard to the existing "Add keys" form.
  3. **Pre-selects** that service in the form's dropdown so when the
     user returns to the tab the right input fields are already there.
- The catalog grows from today's 36 services to ~50 — adding the
  obvious neighbours the launch user base will reach for first
  (Apollo, Postiz, Typefully, Linear, Notion, Brevo, Mailgun,
  Postmark, PlanetScale, Fly.io, Lemon Squeezy, Paddle, Clay,
  DigitalOcean).
- No CLI surface — browsing is a visual problem. The CLI stays focused
  on key inventory and policy.

## 2. Non-goals

- **Search.** 50 services scan fine. A search bar is over-engineering;
  defer to v2 if usage shows category browsing isn't enough.
- **Popularity ranking / "featured".** Avoids ranking-bias arguments
  and editorial work. Categories alone are enough signal.
- **Logos.** Brand logos require legal review per service and add a
  fetch cost. Tile typography (name + 1-line tagline) is enough.
- **Provider-side authentication / OAuth flows.** Users go fetch their
  own keys; that is the load-bearing UX move that keeps stm's "no
  backend, nothing to compromise" posture intact.

## 3. The data model

`src/catalog.ts` already has 36 entries with implicit category
comments. We promote those comments to a typed field, add a URL per
entry, and (optionally) a one-line tagline.

```ts
export type ServiceCategory =
  | "ai"             // OpenAI, Anthropic, …
  | "database"       // Supabase, Neon, PlanetScale, …
  | "hosting"        // Vercel, Railway, Fly.io, …
  | "auth"           // Clerk, Auth0
  | "payments"       // Stripe, Lemon Squeezy, Paddle
  | "email"          // Resend, SendGrid, Postmark, Brevo, Mailgun
  | "comms"          // Twilio, Slack, Telegram, Discord
  | "social"         // Twitter/X, Typefully, Postiz
  | "sales"          // Apollo, Clay
  | "search"         // Tavily, Firecrawl, Exa, Parallel Web Systems
  | "monitoring"     // Sentry, PostHog
  | "vcs"            // GitHub, Linear, Notion

export interface ServiceDef {
  id: string;
  name: string;
  credentials: string[];
  /** NEW. One of the ServiceCategory constants above. */
  category: ServiceCategory;
  /** NEW. Where the user goes to fetch their key. Prefer the API-keys
   *  settings URL when stable; fall back to the signup page. */
  url: string;
  /** NEW. Optional one-line description for the tile (≤60 chars). */
  tagline?: string;
}
```

All three new fields are required-or-optional **on the build side**
(we curate them); from a runtime perspective `category` and `url` are
required for the browser to render correctly, `tagline` is optional.

## 4. Categories (the taxonomy that ships)

| Category | Display label | Services | Count |
|---|---|---|---:|
| `ai` | AI & LLM | OpenAI, Anthropic, Google Gemini, Groq, Mistral, OpenRouter, fal.ai, Replicate, ElevenLabs | 9 |
| `database` | Database & backend | Supabase, Neon, MongoDB Atlas, Upstash Redis, Firebase, **PlanetScale** | 6 |
| `hosting` | Hosting & deploy | Vercel, Netlify, Railway, Cloudflare, AWS, **Fly.io**, **DigitalOcean** | 7 |
| `auth` | Auth | Clerk, Auth0 | 2 |
| `payments` | Payments | Stripe, **Lemon Squeezy**, **Paddle** | 3 |
| `email` | Email | Resend, SendGrid, **Postmark**, **Brevo**, **Mailgun** | 5 |
| `comms` | Comms & messaging | Twilio, Slack, Telegram, Discord | 4 |
| `social` | Social media | Twitter / X, **Typefully**, **Postiz** | 3 |
| `sales` | Sales & outreach | **Apollo**, **Clay** | 2 |
| `search` | Search & web | Tavily, Firecrawl, Exa, Parallel Web Systems | 4 |
| `monitoring` | Monitoring & analytics | Sentry, PostHog | 2 |
| `vcs` | Dev tools | GitHub, **Linear**, **Notion** | 3 |

**Total:** 50. Existing services (36) get their existing entries
augmented; **bold** marks the 14 net-new entries.

### 4.1 New service entries (the data to land)

Each adds a single line to `CATALOG[]`. Credential field names are the
provider's own naming where stable; pick the most common label
otherwise. URLs link to the API-keys settings page when one exists,
else the signup/dashboard root.

| id | name | credentials | category | url |
|---|---|---|---|---|
| `apollo` | Apollo | `["api-key"]` | sales | https://app.apollo.io/#/settings/integrations/api |
| `postiz` | Postiz | `["api-key"]` | social | https://docs.postiz.com/installation/setup-from-source |
| `typefully` | Typefully | `["api-key"]` | social | https://typefully.com/?settings=integrations |
| `linear` | Linear | `["api-key"]` | vcs | https://linear.app/settings/api |
| `notion` | Notion | `["internal-integration-token"]` | vcs | https://www.notion.so/profile/integrations |
| `brevo` | Brevo | `["api-key"]` | email | https://app.brevo.com/settings/keys/api |
| `mailgun` | Mailgun | `["api-key"]` | email | https://app.mailgun.com/app/account/security/api_keys |
| `postmark` | Postmark | `["server-token"]` | email | https://account.postmarkapp.com/servers |
| `planetscale` | PlanetScale | `["service-token-id", "service-token"]` | database | https://app.planetscale.com/settings/service-tokens |
| `fly` | Fly.io | `["api-token"]` | hosting | https://fly.io/user/personal_access_tokens |
| `lemon-squeezy` | Lemon Squeezy | `["api-key"]` | payments | https://app.lemonsqueezy.com/settings/api |
| `paddle` | Paddle | `["api-key"]` | payments | https://vendors.paddle.com/authentication |
| `clay` | Clay | `["api-key"]` | sales | https://app.clay.com/workspaces |
| `digitalocean` | DigitalOcean | `["personal-access-token"]` | hosting | https://cloud.digitalocean.com/account/api/tokens |

Authoritative source for each URL is the provider's docs at the time
of writing. The cloud build agent **must verify each URL with a HEAD
request and substitute the documented stable path if the link 404s** —
don't ship broken jumps.

### 4.2 Category assignments for the existing 36

| id | category |
|---|---|
| openai, anthropic, google-gemini, groq, mistral, openrouter, fal, replicate, elevenlabs | ai |
| supabase, neon, mongodb-atlas, upstash-redis, firebase | database |
| vercel, netlify, railway, cloudflare, aws | hosting |
| clerk, auth0 | auth |
| stripe | payments |
| resend, sendgrid | email |
| twilio, slack, telegram, discord | comms |
| twitter | social |
| tavily, firecrawl, exa, parallel-web-systems | search |
| sentry, posthog | monitoring |
| github | vcs |

And each gets its `url` populated (the API-keys page on the provider).
The build agent fills these in from the provider docs at build time.

## 5. UX

### Dashboard surface

A new card at the **top** of `<main>`, before "Add keys":

```
┌──────────────────────────────────────────────────────────────┐
│  Browse services                                             │
│  50 services pre-configured. Click any tile to open its      │
│  API-key page and queue it in the form below.                │
│                                                              │
│  AI & LLM ────────────────────────────────────────────────── │
│   [ OpenAI   ↗ ]  [ Anthropic ↗ ]  [ Gemini   ↗ ]  …         │
│                                                              │
│  Database & backend ─────────────────────────────────────── │
│   [ Supabase ↗ ]  [ Neon      ↗ ]  [ Planet…  ↗ ]  …         │
│                                                              │
│  …                                                           │
└──────────────────────────────────────────────────────────────┘
```

- Section header per category (`<h3>` styled like existing
  `.sub-head`).
- Tiles: `display: grid` with `auto-fill, minmax(140px, 1fr)` so 4-5
  tiles fit per row on desktop, 2 on mobile.
- Each tile: service name (sans, semibold) + a small `↗` external-link
  glyph, hover state matches the existing emerald-accent pattern.
- No logos. No taglines on the tile (room is tight). Tagline shows on
  hover (`title` attribute) so screen-reader / keyboard users see it.

### Click behaviour

```js
function pickService(id) {
  window.open(catalog[id].url, "_blank", "noopener,noreferrer");
  // Pre-select in the dropdown
  el("svc").value = catalogIndexOf(id);  // existing CATALOG-by-index API
  renderSvcFields();
  // Smooth-scroll to the form
  document.getElementById("add-keys-card").scrollIntoView({ behavior: "smooth", block: "start" });
  // Highlight pulse to draw attention
  flashCard("add-keys-card");
}
```

The `flashCard` helper adds a 1.5-second emerald outline pulse to the
"Add keys" card so the user's eye finds the form when they switch
tabs back. CSS keyframe; pure addition.

### Empty / fallback state

If `catalog` is empty (which shouldn't happen — it's bundled), the
browser card hides itself rather than rendering an empty shell.

## 6. What this does NOT change

- The existing Service dropdown in "Add keys" stays exactly as is.
  Power users who already know what they want skip the browser
  entirely. The browser is additive discovery.
- The CLI is untouched. `stm add`, `stm list`, etc. don't know about
  categories.
- Storage is unchanged. `tools` rows keep their existing shape; the
  catalog enrichment is *bundled data*, not user data.

## 7. Phasing

| Phase | What lands | Status |
|---|---|---|
| **1.** Catalog schema + 14 new entries + categories on existing 36 + URLs on all 50. Unit tests confirm every entry has a `category`, a `url`, and a credentials list. | This spec build | pending |
| **2.** Dashboard "Browse services" card with the click-open-and-prefill UX. CSS, JS, smooth-scroll, flash pulse. | This spec build | pending |
| **3.** Search box (typeahead) and keyboard navigation. Deferred until usage shows category browsing isn't enough. | v2 | deferred |

## 8. Hard rules

- **No outbound network calls at runtime.** Provider URLs are bundled
  into the catalog at build time. The dashboard does not fetch
  anything from a provider; it only renders the static catalog and
  opens links the user clicks. Matches the project's existing
  no-backend / no-phone-home posture.
- **No tracking on outbound clicks.** Plain `target="_blank"
  rel="noopener noreferrer"`. No analytics, no UTM tags, no redirect
  through subscribetome.pro. The user goes straight to the provider.
- **Catalog stays a one-line addition per service.** Adding a new
  service stays as easy as it is today — one row in `CATALOG[]`.
  CONTRIBUTING.md gets a one-paragraph addition pointing maintainers
  at the new `category` and `url` columns.
- **Existing tests must keep passing.** The catalog test should be
  extended, not replaced. Bun's `expect()` count goes up; failure
  count stays at zero.

## 9. Open questions

1. **Where to put `url` if a provider's API-keys page requires login?**
   v1 answer: link directly to the post-login settings URL. Browsers
   that handle the OAuth bounce gracefully (Google, Stripe) make this
   a non-issue. Providers that 404 on a non-authed direct hit get the
   signup root URL instead. Build agent verifies with a HEAD request.
2. **Should the browser also surface "you already have a key for this
   service"?** Probably yes in v2 — small "✓ already added" pill on
   the tile if the user has an active key for that tool. Defer for
   now; keeps the v1 small.
3. **Add the provider's "what it is" tagline to tiles too?** Defer.
   The category header is the contextual cue. Tagline lives in
   `title` attribute for accessibility.

## 10. Definition of done

- [ ] `src/catalog.ts` exports 50 services. Every entry has
      `category`, `credentials[]`, `name`, `id`, and `url`. Build
      passes type-check.
- [ ] A new card `<section id="browse-services">` renders above the
      existing Add keys card on the dashboard. Visible to anyone
      opening `stm dashboard` after upgrade.
- [ ] Clicking a tile opens that service's URL in a new tab AND
      pre-selects the service in the Add keys dropdown AND smooth-
      scrolls to the form AND triggers a 1.5-second emerald flash on
      the Add keys card.
- [ ] Every URL in the new entries returns HTTP 200 or 3xx (verified
      with a HEAD request at build time). 404s get the signup root
      substitute and a comment in the source.
- [ ] `bun test` passes with at least one new test asserting all
      catalog entries carry the required new fields. Total test
      count goes up from 94+; failures stay at zero.
- [ ] `CONTRIBUTING.md` gets a short paragraph on adding a service
      (one-line `CATALOG[]` entry; mention the category enum and
      url field).
- [ ] Version bumped (next free patch under 0.2.x, or 0.3.0 if the
      catalog migration is judged breaking — it isn't, so patch).
- [ ] CHANGELOG entry describing the catalog expansion + the new
      browser card.
- [ ] `specs/README.md` index row for this spec marked "shipped".
