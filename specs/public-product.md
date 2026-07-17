# Spec — STM as a public product: research findings and plan

**Status:** PLANNING — no code. **Gate 0 PASSED (0.1 / 0.2 / 0.3).** Permission is settled; the mechanism is safe.
**Two open blockers before Gate 1 is worth running:** the segment decision (§2.5.1 — 4B looks wrong) and the data-source trilemma (§3.4 — unsolved).
**Last updated:** 2026-07-17 (full-field competitive sweep, ~45 products — materially revised §2.5)
**Research basis:** two adversarially-verified research passes (214 agents, ~12M tokens, 3-vote refutation per claim), plus three Gate 0 primary-source verifications (§2.6). Raw reports: session task outputs `wcvg7bt89` (payments/regulatory), `wbtx9uwwx` (platform/competitive).

This document exists because the ask — "make STM a public-facing site, and the way
people manage payments through any coding platform or AI platform" — cuts against
four invariants this project currently states as explicit non-goals in
[`TODOS.md`](../TODOS.md): hosted/cloud/sync, team mode, telemetry, browser agents.
Reversing a non-goal is legitimate. Reversing one without writing down what changed
is not. This is the write-down.

It follows the precedent set by [`spend-visibility.md`](./spend-visibility.md) §2
("The honest tension — and the rule that follows"), which is the one time this
project has revisited a load-bearing promise and did it well.

---

## 0. The headline

**The payments product as stated is blocked — by policy, not engineering.** Two
independent gates, either one sufficient:

1. **Anthropic's Software Directory Policy §4.A** (eff. 2026-04-15) bars
   directory-listed software that "transfers money, cryptocurrency, or other
   financial assets, or executes financial transactions on behalf of users."
2. **Stripe Issuing's supported-use-case list** covers "buying to resell /
   procurement" and does *not* include "buying to consume." Issuing is also
   commercial-use-only — individual developers are out of scope by definition.

Neither clears with engineering effort. They are other parties' decisions.

**What survives is narrow, real, and structurally durable:** a ledger of AI
*subscriptions* — flat plans, seats, renewal dates, and which card funds each.
Gate 0.1 confirmed no platform tracks this, and identified **why it will stay that
way: neither vendor has any incentive to surface what you pay their competitors.**
That is a stronger argument than "nobody's gotten to it yet."

**Two things are now known that weren't when this doc was first drafted:**
- **Charging users for a plugin is not prohibited.** Verified by literal text search
  (§2.6). But the silence has **no contractual durability** — the governing terms are
  unilaterally amendable without notice.
- **The competitor isn't Anthropic. It's the FinOps vendors.** Anthropic exports
  usage to Datadog/CloudZero and treats aggregation as a *partner* surface (§2.5).

**The mechanism is safe — and better than safe.** Gate 0.2 resolved the authentication
worry: the policy is real, but it restricts *routing other people's Pro/Max OAuth
credentials*, not handling a user's own API key. Anthropic's own docs point developers
to API-key auth as the sanctioned path, and document **`apiKeyHelper` — a shell script
returning a key, "for dynamic or rotating credentials, such as short-lived tokens
fetched from a vault"** — which is STM's mechanism, blessed by name (§2.6).

**Gate 0 is fully passed. The blocking unknown is now demand (§3.3), not permission.**

---

## 1. What the research changes about the four answers

The four decisions were answered **1C / 2A / 3B→A / 4B**. Verdict on each:

| # | Answer | Verdict | Why |
|---|--------|---------|-----|
| 1 | **C** — track now, move money later | **Half-invalid.** "Track now" is right. "Move later" is not a deferred build; it is a different company. | Blocked by Directory Policy §4.A *and* Stripe's use-case list. |
| 2 | **A** — hybrid, secrets local + metadata sync | **Unevidenced — do not commit yet. And now hard-constrained.** | Research question #5 returned zero verified claims: no precedent, no cost estimate, no market-reception data. Gate 0.2 adds a live constraint: Consumer Terms bar sharing the API key "with anyone else," so 2A is viable **only** if secrets genuinely never sync. The hybrid line is now contractual, not just principled. |
| 3 | **B→A** — read spend, then spend | **B viable. A blocked.** | B is directory-legal and silent-on. A trips §4.A, *and* the rails don't offload injection risk — you'd own it yourself. |
| 4 | **B** — teams/startups | 🔴 **NEEDS RE-OPENING. The evidence points at 4A.** | 4B is occupied: 1Password shipped AI spend there 2026-07-14 (free, bundled), Ramp GA'd 2026-07-16, Zylo in April. The **only** structurally defensible ground is the individual developer — locked out of every incumbent by incorporation requirements and $25–50k balance floors that are *regulatory*, not commercial (§2.5.1). But 4A's price ceiling looks like **$7.99 one-time**. The moat and the money are in different segments. |

The correction that matters: **1C was chosen specifically to keep the path to phase 2
open. That path is closed.** If phase 2 is the point, this is the wrong plan, and the
honest move is to reconsider rather than build phase 1 as a down payment on something
that cannot follow.

---

## 2. What is actually true

### 2.1 The agentic rails do not support this use case

- **Every shipped rail is merchant-side. STM is buyer-side.** That is simultaneously
  the gap and the reason no rail helps.
- **ACP** (OpenAI+Stripe, Apache 2.0) is genuinely maintained — five dated specs
  2025-09-29 → 2026-04-17. But `allowance.reason` accepts only `"one_time"` and
  multi-use tokens are *explicitly out of scope*. Recurring subscription billing is
  not covered. Meanwhile OpenAI **retreated from in-chat checkout in March 2026**,
  moving purchases out to Apps. Spec health and commercial traction are diverging —
  both true; don't collapse them.
- **x402**: ~130M transactions is dust — $0.30–0.52 average, ~$41–50M cumulative.
  Dollar volume fell ~77% from its Nov-2025 peak. 74% of Base merchants sit behind
  one facilitator. A May-2026 audit found **all four official Coinbase SDKs fail
  resource binding** (signature for resource A accessed equal-priced resource B in
  100/100 trials). Patch status unconfirmed — sources conflict on v2.5.0 vs v2.6.0.
- **AP2's cryptographic mandates do not solve agent-spend security.** Attacks operate
  *pre-signature*, on the reasoning layer, producing "cryptographically valid but
  intent-misaligned mandates." Prompt injection is not in AP2's threat model at all.
  Strongest evidence is an admission against interest: ZTRV, a paper proposing an AP2
  *enhancement*, concedes it "cannot prevent authorized misuse scenarios in which a
  legitimate agent is manipulated such as through prompt injection."
  → **Any spend authority STM grants, STM secures itself.**

### 2.2 The card layer is blocked, not merely expensive

- Stripe Issuing "currently only supports commercial use cases"; individual
  cardholders must be "an employee or contractor of your business."
- Supported use cases: corporate expense, reseller, on-demand services. **"Buying to
  consume" is absent.** Sharper gate than any revenue threshold.
- Live mode is manually reviewed. **Every substantive change to marketing, app flow,
  or user comms requires fresh Stripe+bank review, 10-business-day SLA**, enforced by
  capability disabling. For a team shipping weekly that is the binding constraint.
- Before card #1: complaints intake, disputes, money-transmission receipt delivery,
  regulated notices, 5-year retention across four document classes. None is product.
- **Cledara settles the economics.** Every tier indexed to a staff count starting at
  25. No solo tier. The £100/mo "Basic" fee is a *penalty* applied when card volume is
  absent. Interchange does not close at STM's scale.

### 2.3 The tracking wedge is genuinely low-scope

Storing **last-4 + nickname is PCI's own sanctioned truncation method** (Req 3.5.1),
not a workaround.

⚠️ **Do not overstate this.** Verifiers killed two stronger framings — "PCI doesn't
apply" (1-2) and "store no PAN eliminates scope" (0-3). It is scope **reduction,
conditionally**: only with segmentation, and only if STM never also holds the PAN or a
hash of it. Req 3.5.1 specifically warns against storing a hashed *and* truncated PAN
of the same card, since the truncated part enables hash recovery.

**Rule, for the README, in the style spend-visibility.md established:**
> STM stores at most the last four digits and a nickname. It never stores a full card
> number, and never a hash of one. If we cannot hold that line, we don't ship the feature.

### 2.4 The platform gate — verified verbatim (Gate 0.3)

**Directory Policy §4, complete text:**
> **4. Unsupported Use Cases.** Unless otherwise expressly permitted by us in writing,
> we do not allow Software with certain capabilities into our Directories. We may
> revisit these restrictions as our Directories and Anthropic Services evolve.
> **A.** Software that transfers money, cryptocurrency, or other financial assets, or
> executes financial transactions on behalf of users.
> **B.** Software that uses AI models to generate images, video, or audio content. […]
> **C.** Software that serves advertisements, sponsored content, paid product
> placements, or exists primarily as an advertising or promotional vehicle.

**Corrections to this document's first draft — both in STM's favor:**

- **§4.C does not bar charging users.** It bars *ad-funded* software. "Paid product
  placements" is the only restrictive use of "paid" in any governing document. The
  actual pattern: **Anthropic restricts plugins that *are* financial infrastructure or
  ad vehicles, and says nothing about plugins that *cost money*.** Affiliate/referral
  monetization is out; charging users is not.
- **§4's preamble is scoped "into our Directories."** It is a **listing condition, not
  a distribution prohibition**. Plugins ship via any GitHub repo, git URL, local path,
  or self-hosted `marketplace.json` with zero Anthropic approval. The price of
  independence is **all discovery** — the official marketplace is curated, has no open
  submission path, and no documented community→official promotion route.

**Commercial ToS D.4, complete text:**
> **D.4. Use Restrictions.** Customer may not and must not attempt to (a) access the
> Services to build a competing product or service, including to train competing AI
> models or resell the Services except as expressly approved by Anthropic; (b) reverse
> engineer or duplicate the Services; or (c) support any third party's attempt at any
> of the conduct restricted in this sentence.

- The operative phrase is **"resell the Services"** — reselling *Anthropic's*
  Services, not charging for your own software. **This substantially defuses the
  earlier concern that D.4 might bite a key-injection plugin.** Still worth a lawyer's
  read (§4, Gate 0.4), but it is no longer the headline risk this doc first implied.

**Enforcement and durability:**
- Enforcement is **ongoing, not one-time**. The sibling Directory *Terms* carry an
  unconditional removal right: Anthropic "may remove or refuse to display any
  Software… at any time for any reason." **A listed read-only plugin whose sibling
  product issues cards can still be delisted at discretion.**
- ⚠️ **The silence has no contractual durability.** Directory Terms: *"Anthropic
  reserves the right to modify these terms at any time without prior notice, and your
  continued submission or maintenance of Software in one or more Directories after any
  such changes constitutes your acceptance of the revised terms."* Both documents were
  revised within the last four months (Mar/Apr 2026). **Do not build anything whose
  economics depend on the monetization silence persisting.**
- The Directory Terms license grant covers only *descriptions, documentation, name,
  trademarks, logos and branding*, "in connection with presenting the Software in the
  Directories." It is **not** a license to the software, and **not** a revenue claim.
  Easy to misread; noted so nobody does.

### 2.5 The competitive picture — and who the competitor actually is

- **Spend caps are commoditized.** Cloudflare AI Gateway shipped dollar-denominated
  spend limits on **2026-06-05** — free tier, HTTP 429 enforcement, aggregates across
  providers. *STM's spend-control wedge is not a gap.* (Cloudflare's own caveats:
  best-effort estimation, eventually consistent, 20 rules max, known-pricing models.)
- **BYOK is commoditized.** Vercel, OpenRouter, Portkey, LiteLLM all ship it.
  *STM's key-management wedge is not differentiated at the gateway layer.*
- **The subscription gap — REVISED 2026-07-17 after a full-field sweep (~45 products).**
  The original two-vendor claim was too broad. **Two of its three clauses are retired:**

  | Original clause | Status |
  |---|---|
  | "Gateways track only metered API cost" | ❌ **Retired.** Datadog CCM, Vantage, Finout, Zylo, Ramp all ingest flat AI seat cost as a real dollar line item — from the card/SaaS side, often free, card data already attached. |
  | "Nothing tracks flat subscriptions + renewal dates" | ❌ **Retired.** Renewal tracking is this category's *core business*: Cledara, 1Password/Trelica, Ramp Vendor Mgmt, Sastrify, Productiv. |
  | "Nothing knows which card funds which subscription" | ⚠️ **False for Cledara** — card-per-subscription is its architecture, because *Cledara issues the card*. Unverified for 1Password. Holds elsewhere. |

  **What actually survives, stated precisely:**
  > **None models a subscription as a term.** No product knows your Claude Max renews
  > on the 14th, or which card funds it. Generic SaaS tools do renewals for generic
  > SaaS; AI-specific tools do metered tokens. **Nobody joins them.**
  > Claude Max/Pro appear in **zero product docs across all vendors checked.**

  **Why it holds structurally — use this, not a feature-gap argument:**
  > **A gateway prices requests; a seat emits no request.**

  Set request volume to zero: every metered product reports $0 and the Max seat still
  bills $200. Cledara is the sole renewal+card exception *because it issues the card* —
  everyone else reads admin APIs and SSO logs, which never expose the funding
  instrument. **That is the structural key to the whole category.**

  **Citable competitor admissions** (verified verbatim — unlike the Cledara quote, §7):
  - Finout docs: Codex seat fees *"never appear in the Analytics API."*
  - Torii: *"not your invoice amount. Most AI tools run on flat subscriptions."*
  - TrueFoundry on routing claude.ai: gives audit *"but not token-level cost tracking."*
- **A competitor is contesting it.** **Carrot Labs / SuperPenguin** (YC W26, 2 people,
  live, Free / $30 / $200 / $20K+) tracks ~14 providers plus "100+ via LiteLLM,"
  advertises "invoice reconciliation," lists Cursor. **Their own blog names the gap**:
  their product "still centers on usage metrics rather than subscription seats or
  renewals" — and, their words, **"The seat is only half the bill."**
  → **They have seen this gap and not shipped it. That is a schedule, not a moat.**
- 🔑 **The real competitor is the FinOps layer, not Anthropic** (Gate 0.1). Anthropic's
  Enterprise Analytics API exports to Datadog and CloudZero — they treat aggregation
  as a **partner** surface they won't build. Favorable for the wedge; but it means STM
  competes with Datadog/CloudZero/Zylo/Vendr/Ramp, not with Claude Code.

### 2.5.1 The segment problem — this contradicts decision 4B

**The individual developer is structurally excluded from every incumbent:**

| Vendor | Floor to buy |
|---|---|
| Ramp | incorporation + **~$25,000** min. bank balance |
| Brex | incorporation + **$50,000** |
| Cledara | £100/mo + company verification, ~25-staff floor |
| Sastrify | **€12.5k/yr** |
| Zylo · Torii · Productiv · Vertice · 1Password SaaS Manager | **no published price — demo/quote only** |

**A solo dev with a Claude Max seat on a personal card cannot buy any of these at any
price.** For Ramp and Brex this is not pricing — it is *regulatory underwriting*. They
cannot close it without becoming consumer fintechs.

**So the defensible ground is 4A (individuals), which was explicitly rejected.** 4B puts
STM in a room with 1Password (free, bundled, shipped 2026-07-14), Ramp (GA 2026-07-16),
and Zylo — offering nothing they don't. **This decision needs re-opening.** The moat is
in 4A; the willingness-to-pay is not (see Tokens 4 Breakfast: $7.99 **one-time**).

**The honest reformulation:**
> Everything that tracks flat subscriptions with renewal dates is an enterprise
> procurement tool sold to finance via a rep. Everything AI-specific tracks metered
> tokens, because that's what admin APIs expose. **Nothing an individual developer can
> buy knows what their Claude Max seat costs, when it renews, or which card pays it.**

### 2.5.2 Named competitors, ranked by threat

1. **1Password — AI Spend & Consumption Management, shipped 2026-07-14.** Public
   preview, GA fall 2026, **free to SaaS Manager customers**, covers Anthropic/Cursor/
   OpenAI. Trelica (acq. 2025-01) already does contracts, cost-per-unit, auto-renew
   flags, and 90-day renewal dashboards. **Closest anyone comes.** Deliberately rejects
   card/invoice inference — connects to admin APIs *"rather than inferring spend from
   card transactions, invoices, or manual exports."* Enterprise, quote-only.
2. **Ramp — AI Token Spend GA 2026-07-16.** Early access → GA in **3 months**. Vendor
   Management separately tracks renewals + *"associated cards & funds"* — but with
   **zero AI awareness**, disconnected from the token product. Their own AI Index proves
   they can already classify "subscriptions vs. coding agents vs. tokens" in the
   warehouse. **That gap is packaging, not capability.**
3. **Tokens 4 Breakfast** — macOS menu bar, **$7.99 one-time**, local-first, reads
   `~/.claude/projects/` JSONL. FAQ (verified): *"a subscription tracker where you can
   add flat-rate subscriptions like Claude Pro, ChatGPT Plus, Cursor Pro, GitHub
   Copilot."* Reaches the dollar line item; **misses renewal date and card**; entry is
   manual. **This is the price ceiling for 4A.**
4. **`nkur22/subscription-tracker` — 0 stars, last commit Mar 2026.** A Claude skill
   scanning Gmail via MCP, computing renewals from payment history. **The only thing
   hitting the full crux.** That a 0★ hobby project is the closest competitor is the
   strongest evidence the position is unoccupied — *and* it confirms the only mechanism
   that reaches consumer plans is **email/receipt ingestion**.

### 2.5.3 ⚠️ Claude Code "integrations" are anti-correlated with this thesis

Respan, Bifrost, Martian, and Portkey all support Claude Code by rewriting
`ANTHROPIC_BASE_URL` to bill through **their** key. Bifrost states it: *"No credits are
needed on the Anthropic account since billing goes through your Bifrost virtual key."*

**They don't track the $200/mo Max seat — they abolish it.** These are *substitutes
competing for the same budget*, not competitors with a feature gap. If they win, the
subscription STM proposes to track stops existing.

### 2.6 Gate 0 verification results

**✅ Gate 0.1 — First-party risk: GO, wedge narrowed.**

Platform owners have thoroughly colonized *metered API spend for their own service*:
- **Claude Code `/usage`** (GA): plan-limit bars, plus usage attribution to individual
  skills, subagents, plugins, and MCP servers (v2.1.169+). Scope limit: "computed from
  local session history on this machine, so usage from other devices or claude.ai is
  not included."
- **Claude Code `/usage-credits`** (GA, v2.1.207+): on Pro/Max, an in-CLI dialog to buy
  credit bundles, **set a monthly spend limit**, and **configure auto-reload** below a
  threshold. ⚠️ **This document's first draft was a version behind in claiming `/cost`
  was the state of the art.** Anthropic already owns "spend limit + funding threshold"
  inside the CLI. It is a top-up wallet for metered overage — it does not surface the
  subscription fee, its renewal date, or the funding card as managed objects.
- **Console**: Spend Limits API (Enterprise only, monthly period only), workspace spend
  limits, Usage & Cost API (token metering; **no subscription-seat concept in the
  schema**).
- **OpenAI**: Codex `/status` is minimal (an open issue since 2026-03-20 calls it
  "often inaccurate/stale"). Platform project budgets are a **soft alert, not a hard
  cap** — "API requests will continue to be processed without interruption."
  ⚠️ Sourced from search indexing; help.openai.com 403s to direct fetch.

**Confirmed absent on both platforms:** flat subscription spend (Anthropic's own docs:
*"Usage inside the seat allowance isn't metered in dollars"*), renewal dates, funding
cards as tracked objects, anything cross-vendor. **Claude Code has no third-party key
management** — no vault, no credential store for other vendors. STM's mechanism is
unthreatened.

**✅ Gate 0.3 — Terms silence: CONFIRMED, hardened by literal text search.**

Method note: performed via `curl` + tag-stripping + literal regex over raw bytes —
**not** summarizing WebFetch, which is what produced the original soft conclusion. All
six documents returned full body text.

- `"revenue share"`, `"monetize"/"monetization"`, `"commission"` — **0 occurrences
  across all six documents.**
- In the two docs governing plugins (Directory Policy, Directory Terms) plus both
  Claude Code docs pages: `revenue`, `billing`, `monetiz*`, `pricing`, `commission`,
  `resell`, `sublicense`, `competing`, `payment`, `merchant` are **all absent.**
- **Trap caught:** the Commercial ToS *does* contain "plugin" and "marketplace" — **only
  in site nav/footer chrome** ("Ecosystem Marketplace", "Events Plugins"). A naive grep
  reports FOUND and misleads. The operative contract body is genuinely silent.
- Dates: Commercial ToS eff. 2025-06-17 · AUP eff. 2025-09-15 · Directory Policy
  2026-04-15 · Directory Terms 2026-03-16 · plugin docs undated.

**✅ Gate 0.2 — Feb-2026 authentication policy: PASS. The policy is real; it does not
restrict STM. It endorses STM's approach.**

Primary source is **not** an `anthropic.com/legal/*` document — it is a section of
https://code.claude.com/docs/en/legal-and-compliance. Current text, verbatim:
> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro,
> Max, Team, and Enterprise subscription plans […] **Developers** building products or
> services that interact with Claude's capabilities […] should use API key
> authentication through Claude Console or a supported cloud provider. **Anthropic does
> not permit third-party developers to offer Claude.ai login or to route requests
> through Free, Pro, or Max plan credentials on behalf of their users.**

**The distinction that decides it:**

| | Status |
|---|---|
| Third-party tools using **Pro/Max OAuth tokens** | **Restricted.** Squarely the target. |
| Third-party tools handling **a user's own API key** | **Not restricted — the policy directs developers here.** |
| Impersonating the official client | The Jan-9 *technical* enforcement, not this text. |

The prohibition is scoped by **"on behalf of their users"** — it targets a developer
intermediating *someone else's* consumer subscription. A user's own Console API key, in
their own keychain, on their own machine, is the explicitly recommended alternative.

**Anthropic documents STM's exact mechanism as first-class.**
https://code.claude.com/docs/en/authentication describes **`apiKeyHelper`**: a setting
that "can be configured to run a shell script that returns an API key," listed at
credential precedence #4 — *"Use this for dynamic or rotating credentials, such as
short-lived tokens fetched from a vault."* That is vault-backed key injection, named
and sanctioned.

**Three corrections to the background this worry rested on:**
1. **The date is wrong.** Wayback CDX: absent 2026-02-01, present 2026-02-18. "Feb 19"
   is when it was *noticed*, not published.
2. **The quoted language is stale.** The Feb–Apr version read: *"Using OAuth tokens
   obtained through Claude Free, Pro, or Max accounts in any other product, tool, or
   service — including the Agent SDK — is not permitted and constitutes a violation of
   the Consumer Terms of Service."* **That sentence was deleted between 2026-04-01 and
   2026-04-21.** Every secondary source still quotes the withdrawn wording.
3. **HN 44763110 does not exist as described.** That thread is *"Anthropic revokes
   OpenAI's access to Claude"* (~Aug 2025), about competitor-access clauses. Unrelated.
   The Register (2026-02-20) is real and accurately quoted the then-live text. SitePoint
   is real but concerns commercial terms for wrapper SaaS — and it **recommends BYOK**,
   i.e. what STM already does.

**Meta-finding worth carrying:** the most-cited sentence in this controversy was
silently deleted ~2 months after publication while every article still quotes it.
Anyone reasoning about this from secondary reporting is working from withdrawn text.

**Three design constraints this imposes — treat as invariants:**
1. **Never touch Pro/Max OAuth tokens.** If STM ever adds "log in with Claude.ai" or
   handles `CLAUDE_CODE_OAUTH_TOKEN`, it lands *inside* the prohibition. Keys-only is
   the safe side of the line.
2. **The key must never leave the user's machine.** Consumer Terms (eff. 2025-10-08):
   *"You may not share your Account login information, Anthropic API key, or Account
   credentials with anyone else."* A local OS keychain satisfies this. **Any telemetry
   or server-side relay would not.** ⚠️ This directly constrains Phase 3 (2A): a hybrid
   architecture is only viable if secrets genuinely never sync.
3. **This is a docs page, not a contract**, edited quietly without a changelog — as the
   April rewrite proves. The operative instruments are the Consumer/Commercial Terms.
   Re-check periodically; do not treat as settled.

---

## 3. What we still do not know

### 3.1 ~~First-party risk~~ — RESOLVED by Gate 0.1. See §2.6.

The structural finding worth carrying forward: **neither vendor has any incentive to
surface what you pay their competitors.** That is the durable form of the argument.
Watch `/usage-credits` — it is the closest encroachment and already owns spend-limit +
funding-threshold inside the CLI.

### 3.2 ~~The Feb-2026 authentication policy~~ — RESOLVED by Gate 0.2. See §2.6.

The policy is real but restricts *routing other people's Pro/Max OAuth credentials*,
not handling a user's own API key — which Anthropic's docs actively recommend, and
whose vault-backed injection pattern (`apiKeyHelper`) they document by name.

Carry forward the three invariants in §2.6: never touch Pro/Max OAuth tokens; the key
never leaves the machine (**this constrains Phase 3**); re-check periodically, because
it's a quietly-edited docs page rather than a contract.

### 3.3 Demand — the bear case nobody tested

Verifiers flagged it explicitly and it remains the most plausible way this is all
wrong: **a uniform absence across vendors may indicate low demand rather than an
unserved need.** Nobody has tested whether a team will pay for "what am I paying across
all my AI tools, on which card, renewing when."

Gate 0.1 sharpens the question. The competitor is the FinOps layer, so the interview
question is **not** "would you use a dev tool for this" — it is **"why isn't this
already in your FinOps stack, and what does its absence cost you?"**

### 3.4 The data-source trilemma — UNSOLVED, and it gates Phase 1

Surfaced by the 2026-07-17 sweep; absent from both earlier passes. **Phase 1 says "add
renewal dates + funding card." From where?**

> **For an individual Claude Max subscriber there is no billing API exposing "$200/mo,
> renews the 14th."** Every billing API — GitHub Copilot seats, Cursor Admin,
> Anthropic Usage & Cost — is org/enterprise-scoped. Consumer tiers have no Admin API
> to connect. That is the structural reason no vendor names Claude Pro/Max.

Three possible sources. All three are bad:

| Source | Problem |
|---|---|
| **Manual entry** | A spreadsheet with extra steps — the exact critique that killed option 1A. Tokens 4 Breakfast already does this for **$7.99 one-time**. |
| **Admin APIs** | Org-scoped → teams only → the room where 1Password just landed, free and bundled. |
| **Email / receipt parsing** | The only mechanism that reaches consumer plans (confirmed by the 0★ Gmail-MCP project). **Requires reading the user's email — identity-destroying for a tool whose pitch is "zero telemetry, local-only."** |

**This is now the hardest unsolved problem in the plan, ahead of demand.** Gate 1 must
ask it directly: *where would the renewal date come from?* If ten people answer "I'd
type it in," the product is a $7.99 menu-bar app.

⚠️ **Note the pattern before choosing "card/invoice ingestion" as the differentiator:**
SuperPenguin named the gap and didn't ship it. 1Password designed it out *explicitly*.
Two competent teams looked at card/invoice inference and declined. That is evidence
about the gap's desirability, not merely its availability.

**One tailwind, for balance:** Amex added a **$300/yr ChatGPT Business statement credit
(2026-05-12)** — the first named AI benefit on a major US card, making card-level AI
subscription attribution newly legible.

### 3.5 Also unresearched

- **Trust model (Q2/2A):** no evidence on E2E-sync precedent (1Password, Obsidian,
  Bitwarden, Standard Notes), on developer backlash to local-first tools adding sync, on
  off-the-shelf options (Automerge, Turso/libSQL, Evolu, Jazz, Zero), or on whether
  "secrets local, metadata synced" reads as credible or as betrayal.
- **Distribution reality:** no install numbers, no marketplace traffic, no top-vs-median
  distribution. Independent distribution is legally free but forfeits all discovery —
  and we have **no basis for any install expectation whatsoever.**

---

## 4. The plan

### Gate 0 — Verify before building

- [x] **0.1** First-party risk. → **PASS**, wedge narrowed. §2.6.
- [x] **0.2** Feb-2026 auth policy primary source. → **PASS.** Policy is real but targets
      OAuth-credential intermediation, not own-key handling; `apiKeyHelper` documents
      STM's mechanism as first-class. Three invariants imposed. §2.6.
- [x] **0.3** Verbatim text search of Commercial ToS / AUP / Directory Policy+Terms.
      → **PASS**, silence confirmed, two readings corrected in STM's favor. §2.4, §2.6.
- [ ] **0.4** Lawyer reads Commercial ToS **D.4** against the key-injection design.
      *Downgraded in urgency* — 0.3 showed D.4's operative phrase is "resell the
      Services," i.e. Anthropic's Services, not charging for your own software. Still
      worth confirming; no longer the headline risk.
- [ ] **0.5** Ask Anthropic directly: is there a waiver path for §4.A ("expressly
      permitted by us in writing")? Does a listed read-only plugin risk delisting if a
      sibling product issues cards? Undocumented. Long latency — **send early.**

### Gate 1 — Demand test (2 weeks, no code)

- [ ] **1.1** 10 conversations with the target (4B: teams/startups with a budget
      holder). Ask **"what do you do today, and what does it cost you?"** — never
      "would you use this." The first question gets politeness; the second gets truth.
- [ ] **1.2** Test the bear case honestly against the *right* competitor: the FinOps
      layer. If the answer is "finance handles that in Ramp," the wedge is occupied —
      just not by a dev tool. That is a result, not an objection to overcome.
- [ ] **1.3** Falsifiable bar, set now, before we're invested: **if fewer than 3 of 10
      describe this unprompted as a real recurring problem, do not build.**
- [ ] **1.4 NEW — resolve the segment first (§2.5.1).** 4B is occupied. Interview *both*
      4A and 4B and let the answers pick, rather than defending a choice made before the
      sweep. Ask 4B directly: **"you already have 1Password — why isn't this solved?"**
- [ ] **1.5 NEW — ask the data-source question (§3.4):** *"where would the renewal date
      come from?"* This gates the build harder than demand does. Ten "I'd type it in"
      answers means the product is a $7.99 menu-bar app that already exists.

**Prerequisite before Gate 1 is worth running:** settle §2.5.1 and §3.4. Interviewing
for a segment that's occupied, about a feature with no data source, wastes the two weeks.

### Phase 1 — The ledger (only if Gates 0+1 pass)

The wedge, precisely: **the AI subscription ledger — flat plans, seats, renewal dates,
and which card funds each.** The thing gateways structurally cannot see and platform
owners have no incentive to build. Not metered API cost — that is commoditized,
contested, and now substantially owned by Anthropic itself.

Local-first. No cloud. No cards. No money movement.

- Extend the existing schema — `tools` already carries `plan`, `monthly_cost`,
  `renews_on`. Add: funding card (last-4 + nickname **only**), billing cadence, seat
  count, owner.
- Renewal reminders. Local.
- Reuse `dashboard.ts` (1795 LOC, already a working local web UI).
- **Close the spend-sync gap first**: sync exists for **2 of 51 catalog services**
  (OpenAI, Anthropic). "See all your AI spend" is currently **4% true**. That gap
  damages the pitch more than any missing feature.

**Explicitly not in Phase 1:** cloud sync, accounts, team mode, cards, payments, agent
spend authority.

### Phase 2 — Agent read surface (3B)

MCP/read surface exposing the ledger to Claude Code and Codex read-only. Directory-legal
(§4.A concerns money movement; read-only display is silent-on). Small blast radius:
injection can mislead, not spend.

### Phase 3 — Hosted/hybrid (2A) — GATED, NOT SCHEDULED

Only after Phase 1 demonstrates pull, and only after §3.4's trust-model research is
actually done. This is where the "zero telemetry / no servers" promise gets rewritten
publicly and honestly, per the spend-visibility.md precedent — or not at all.

**Hard constraint from Gate 0.2:** Consumer Terms bar sharing an Anthropic API key
"with anyone else." A local OS keychain satisfies that; **a server-side relay does
not.** So the hybrid split isn't merely a marketing position we chose — the
secrets-stay-local half is load-bearing against a live term. If Phase 3 ever tempts a
"just sync the vault too" shortcut, that shortcut is prohibited, not just off-brand.

### Phase 4 — Cards / payments — NOT PLANNED

Blocked by Directory Policy §4.A and Stripe's use-case list. Revisit only if: Anthropic
grants a written waiver, **or** Stripe confirms "buying to consume" is supportable,
**or** the product stops needing directory distribution and can afford to lose all
discovery. Until one is true, **this is not a roadmap item.**

---

## 5. Kill criteria

1. ~~Anthropic/OpenAI ships native spend management.~~ **Checked (0.1): they have — for
   their own metered API spend only.** Reframed: *kill if either ships **cross-vendor**
   subscription tracking.* Gate 0.1 argues they won't — no incentive to surface
   competitors' pricing — but `/usage-credits` shows how fast the CLI surface moves.
2. ~~The Feb-2026 auth policy bars third-party credential handling.~~ **Checked (0.2):
   it does not — it endorses own-key handling.** Reframed: *kill if STM ever needs
   Pro/Max OAuth tokens to work, or if the key ever has to leave the machine.* Both are
   inside the live prohibition. This is now a **design constraint, not a risk.**
3. **Fewer than 3/10 in Gate 1 name this as a real problem.** The gap is empty because
   it's unwanted, not because it's unserved.
4. **SuperPenguin ships subscription/seat/renewal tracking.** They've published the gap.
   Their shipping it doesn't make us wrong — it makes us late, with no moat.
7. **NEW — 1Password ships a self-serve Business tier of SaaS Manager.** The 4A moat is
   *go-to-market, not technical*: enterprise SaaS-management vendors have never sold
   self-serve to individuals. That moat evaporates the day one of them tries.
8. **NEW — the gateways abolish the seat.** Bifrost/Respan/Martian/Portkey "support
   Claude Code" by routing `ANTHROPIC_BASE_URL` through their own billing (§2.5.3). If
   that pattern wins, the flat subscription STM proposes to track **stops existing**.
   This kills the wedge without anyone building a competing feature.
9. **NEW — the data-source question has no good answer** (§3.4). If Gate 1 says "I'd
   type it in," the honest product is a $7.99 menu-bar app, and one already exists.
5. **Any breach or trust erosion.** The zero-telemetry claim is the only asset that
   isn't commoditized.
6. **NEW — the monetization silence closes.** The Directory Terms are amendable without
   notice and were revised twice in four months. Any plan whose economics depend on that
   silence is built on sand.

---

## 6. Decay clock

Every dated fact here has a short half-life, **and most move against STM's
differentiation**:

- Cloudflare spend limits shipped **2026-06-05** — six weeks before this document.
- Claude Code `/usage-credits` spend limits + auto-reload: **v2.1.207**, current `main`
  is 2.1.211. The CLI surface is moving weekly.
- Directory Policy is three months old and **self-describes as mutable**: "We may
  revisit these restrictions as our Directories and Anthropic Services evolve."
- SuperPenguin is a 2-person W26 company that has **already publicly named the gap**.
- **1Password shipped AI spend 2026-07-14. Ramp GA'd 2026-07-16.** Both landed *during
  the drafting of this document.* Ramp went early-access → GA in **three months**;
  1Password went contracts → shadow-AI → token spend in 18. **Brex has pre-announced
  intent** (internal "Magpie" dashboard) — treat its absence as a roadmap item, not a
  gap. The category is consolidating faster than this plan can be executed.
- Stripe's Sessions 2026 *previewed* self-serve issuing, Issuing for agents, and
  consumer debit — all announcement-stage, any of which would change §2.2.

**Re-check in 90 days is not optional.**

---

## 7. Research caveats carried forward

Stated so a future reader doesn't over-trust this document:

- ⛔ **DO NOT PUBLISH these three — they did not survive verification:**
  1. The Cledara line *"subscription-based personal accounts cannot be connected."*
     `help.cledara.com` returns **Cloudflare 403** to every fetch; this is
     search-snippet-sourced, not verified. It was briefly cited as the strongest
     evidence for the thesis and is in fact the least citable. Needs a manual browser
     pass before any external use.
  2. A quote attributed to **Finout's Anthropic page** — could not be reproduced. (The
     *Codex* equivalent — seat fees *"never appear in the Analytics API"* — **is**
     verified verbatim and is safe to cite.)
  3. A **DigitalOcean acquisition of Arch/Katanemo** — unverified; archgw.com carries
     no such notice.
- The subscription-gap finding was **revised twice**. The original was two vendors
  (Cloudflare, Vercel) and **too broad — two of its three clauses are now retired**
  (§2.5). The surviving claim is narrow: *nothing models an AI subscription as a term.*
  It rests on an **architectural constraint two vendors confirm in writing**, not on
  silence — which is why it survives where the broader phrasing didn't.
- **Vendor catalogs are undocumented across the entire field.** Whether Claude Max /
  Cursor / Copilot are recognized catalog entries **cannot be determined from public
  docs for any vendor.** Absence of evidence is genuinely weak here; a trial account is
  the only way to settle it. Same for **1Password's card↔subscription attribution** —
  the single most important unresolved competitive question.
- **Not reached:** Airbase, Navan. **403/404-gated:** Cledara help center, Braintrust
  proxy docs, CloudEagle (login-gated, marketing-only), Vertice (publishes no docs site
  at all), all vendor consoles behind login.
- Gate 0.1's OpenAI soft-cap finding is **sourced from search indexing**;
  help.openai.com 403s to direct fetch. The "they removed the hard cap" narrative comes
  only from secondary blogs with no OpenAI announcement — **do not rely on it.**
- Three security findings (x402 SDK audit, AP2 red-team, ZTRV) are **non-peer-reviewed
  arXiv preprints**, none independently replicated. The AP2 "100%" figure is **10/10
  trials against the authors' own reference implementation on one model** — cite as
  "ranking manipulation in 10/10 trials against a reference AP2 agent," never "AP2 is
  100% exploitable."
- Cledara's interchange model rests on a **third-party case study plus structural
  inference**; Cledara discloses nothing and states it charges no percentage-based fees.
- Research questions #4, #5, #6 of the second pass returned zero verified claims; #4 is
  now resolved by Gate 0.1, **#5 and #6 remain open.** Do not read the density of
  findings in §2 as completeness. **Silence is not absence of risk.**
