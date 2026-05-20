# subscribetome — SEO + AI-search playbook

> "Why doesn't this show up when I Google it?"
> Because the domain is hours old. We've laid the technical groundwork; the
> rest is time, links, and submitting to a few directories.

## What is now live (automatic, done)

| Asset | URL | What it does |
|---|---|---|
| `robots.txt` | https://subscribetome.pro/robots.txt | Explicit allow for every major AI crawler (GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot, Google-Extended, …) and Google/Bing |
| `sitemap.xml` | https://subscribetome.pro/sitemap.xml | One-URL XML sitemap |
| `llms.txt` | https://subscribetome.pro/llms.txt | The [llmstxt.org](https://llmstxt.org)-format manifest. This is **the single most important file for AI search visibility**. ChatGPT, Perplexity, Claude.ai, and Bing Copilot fetch it as a high-priority signal of what a domain is about and which docs to cite. |
| `og.png` | https://subscribetome.pro/og.png | 1200×630 share preview. Powers the link card on Twitter/X, LinkedIn, Slack, Discord, iMessage, Bluesky, … |
| `favicon.svg` | https://subscribetome.pro/favicon.svg | Browser tab icon |
| JSON-LD on `/` | inline `<script type="application/ld+json">` | SoftwareApplication, Organization (Matterhorn Labs), WebSite, and FAQPage entities. FAQPage is the one Google AI Overviews quotes directly. |
| GitHub repo topics | 15 tags incl. `claude-code-plugin`, `api-key-manager`, `macos-keychain` | GitHub search discoverability |
| IndexNow submission | Submitted via api.indexnow.org | Pinged Bing + Yandex + DuckDuckGo + Seznam + Naver to crawl |

## What the human has to do (15 min total)

These three steps cannot be automated — each requires a person to claim
ownership of the domain.

### 1. Google Search Console (5 min, highest ROI)

1. Open https://search.google.com/search-console
2. Click **Add property** → **Domain** → type `subscribetome.pro`
3. Google gives you a TXT DNS record to add at your registrar. Add it,
   wait ~10 min, click **Verify**.
4. Once verified, in the left sidebar: **Sitemaps** → paste
   `https://subscribetome.pro/sitemap.xml` → **Submit**.
5. Optional but recommended: **URL Inspection** → paste
   `https://subscribetome.pro/` → click **Request indexing**.

**Expected timing:** first crawl in 1–3 days. First listings in 3–14
days. First meaningful rank in 4–12 weeks (this is normal for a brand
new domain; nothing is broken).

### 2. Bing Webmaster Tools (3 min)

1. Open https://www.bing.com/webmasters
2. Sign in, **Add a site** → `https://subscribetome.pro`
3. Verify (DNS TXT, same flow as Google) — or import from Google Search
   Console if you set that up first (one-click).
4. Sitemap is auto-discovered from `robots.txt`. Nothing else to do.

Bing matters more than usual right now because **ChatGPT Search and
Microsoft Copilot both pull from the Bing index**.

### 3. Twitter/X site card refresh (1 min, after the launch tweet)

After the scheduled thread fires:
1. Open https://cards-dev.twitter.com/validator
2. Paste `https://subscribetome.pro/` → **Preview card**
3. Confirm the OG image renders. (X caches aggressively; this forces a
   refresh.)

## What gets us to actual rankings (weeks 1–4)

The technical pass is done. From here, ranking is driven by **backlinks
from high-authority places that the search engines and AI crawlers
already trust**. In rough priority order:

1. **Hacker News — Show HN.** Title pattern: *"Show HN: subscribetome –
   Open-source API key manager for Claude Code (keys never touch the
   chat)"*. Submit Monday or Tuesday, 9–11am ET. Stay in the thread for
   the first 8 hours to answer questions. A front-page Show HN drives
   ~3–10k visits and is crawled by every AI engine within a day.

2. **Product Hunt.** The maker's first comment and full description
   are already written in [`marketing/product-hunt.md`](./product-hunt.md).
   Tuesday or Wednesday launch is best. Cross-post on X the same day.

3. **Reddit cross-posts (carefully).** Title each post for the subreddit's
   tone. Targets:
   - r/ClaudeAI
   - r/ChatGPTCoding
   - r/LocalLLaMA (the audience cares about API key hygiene)
   - r/MacOS
   - r/programming (use sparingly; they downvote self-promo hard)

4. **"Awesome" list PRs.** One-line additions to these lists are
   easy backlinks from very high-authority pages:
   - https://github.com/hesreallyhim/awesome-claude-code
   - https://github.com/yzfly/Awesome-Claude-Prompts
   - https://github.com/sindresorhus/awesome (only if accepted into a
     sub-list first)
   - any "awesome-cli", "awesome-macos", "awesome-secret-management" list
     that exists

5. **One DEV.to or Medium post.** Cross-publish a 600-word write-up of
   *"Why your Claude Code transcript shouldn't hold your API keys."*
   Both platforms get indexed extremely fast and provide a backlink.

6. **HN comments / X engagement.** When threads about API-key leaks or
   Claude Code tooling appear organically, reply with a one-line "we
   built subscribetome to address exactly this — keys never touch the
   chat" + link. Do not spam.

## Re-submitting to IndexNow on every update

Whenever `docs/` changes, re-ping IndexNow to refresh Bing's copy. From
the repo root:

```bash
KEY=dc0bceeecb314d1fa5504e9c04e88a17  # in docs/${KEY}.txt
curl -sS -X POST "https://api.indexnow.org/IndexNow" \
  -H "Content-Type: application/json" \
  -d "{
    \"host\": \"subscribetome.pro\",
    \"key\": \"${KEY}\",
    \"keyLocation\": \"https://subscribetome.pro/${KEY}.txt\",
    \"urlList\": [\"https://subscribetome.pro/\", \"https://subscribetome.pro/llms.txt\"]
  }"
```

Expect `HTTP 202` on success.

## Sanity checks you can run anytime

```bash
# All four files reachable?
for p in robots.txt sitemap.xml llms.txt og.png favicon.svg; do
  printf "%-15s " "$p"
  curl -sI -m 5 "https://subscribetome.pro/$p" | head -1
done

# JSON-LD valid?
curl -s https://subscribetome.pro/ \
  | sed -n '/application\/ld+json/,/<\/script>/p' \
  | sed -e '1d;$d' \
  | python3 -m json.tool > /dev/null && echo "JSON-LD valid"

# Google's Rich Results test (open in browser):
open "https://search.google.com/test/rich-results?url=https://subscribetome.pro/"

# Twitter / X card validator:
open "https://cards-dev.twitter.com/validator"
```

## Realistic expectations

- **Days 1–3:** AI crawlers (GPTBot, ClaudeBot, PerplexityBot) pull
  `llms.txt`. We start appearing in their answer pools.
- **Days 1–7:** Bing + DuckDuckGo index the site (via IndexNow).
  ChatGPT Search and Microsoft Copilot start citing us.
- **Days 3–14:** Google's first crawl + indexing of the root URL.
  Brand-name searches ("subscribetome") start returning the site.
- **Weeks 2–6:** Long-tail queries ("claude code api key manager",
  "macos keychain claude code", "hide api keys from llm") start
  producing impressions if Show HN / PH / Reddit drove backlinks.
- **Months 2–6:** Real ranking for competitive queries, contingent on
  continued mentions and a few PRs to authoritative directories.

There is no shortcut on the time axis. There IS a multiplier on the
backlinks axis — the more we land in (HN, PH, awesome-lists), the
faster every other curve moves.
