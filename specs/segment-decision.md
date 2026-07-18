# Decision — 4A (individuals) vs 4B (teams)

**Status:** DECISION DOC — open. **Last updated:** 2026-07-17
**Blocks:** Gate 1 in [`gate-1-interviews.md`](./gate-1-interviews.md). Depends on the
sweep in [`public-product.md`](./public-product.md) §2.5.

Decision 4 was answered **B (teams/startups)** before the competitive sweep existed.
The sweep says 4B is occupied. This doc re-opens it with the evidence in hand.

---

## 0. The bind, stated once

> **The pain scales with subscription count. Subscription count scales with org size.**

That single sentence generates the whole problem:

- **The pain is real at 4B.** An org with 30 AI subscriptions across 12 cards genuinely
  cannot answer "what are we paying, on what, renewing when."
- **The pain is thin at 4A.** A developer with Claude Max + ChatGPT Plus + Cursor has
  three subscriptions. They can remember. Nothing is lost by not having a tool.
- **4B is occupied.** 1Password shipped AI spend there 2026-07-14 — free, bundled, to
  customers who already trust them. Ramp GA'd 2026-07-16. Zylo in April.
- **4A is unoccupied — for a reason that may be demand, not oversight.**

**So: 4A has the moat but not the pain. 4B has the pain but not the opening.**

Every argument below is an attempt to escape that sentence. Judge them on whether they
actually do.

---

## 1. The four asymmetries

| | **4A — individuals** | **4B — teams/startups** |
|---|---|---|
| **Distribution** | ✅ STM already has it. Claude Code plugin, MIT, free, zero CAC. This buyer installs things themselves. | ❌ None. This buyer is IT/finance, reached by a sales rep. Every 4B competitor is demo-only *because that's the motion*. STM has no rep, no relationship, no motion. |
| **Moat** | ⚠️ Real but **mixed**. Genuinely *regulatory* vs Ramp/Brex (they'd have to become consumer fintechs). Merely a *GTM choice* vs 1Password/Zylo/Torii — reversible any quarter. | ❌ None. 1Password is already there, free and bundled. You would be selling against free, to their existing customer. |
| **Money** | ❌ Ceiling ≈ **$7.99 one-time** (Tokens 4 Breakfast). Consumer trackers ≈ $5.99/mo. No interchange (Cledara proves it needs 25+ staff). | ✅ A budget holder exists. SuperPenguin sells $30 / $200 / $20k+. This is where revenue lives. |
| **Identity** | ✅ Zero non-goals reversed. Local-first, no telemetry, no accounts — 4A *is* what STM already is. | ❌ Reverses **three** stated non-goals at once: hosted/sync, team mode, telemetry. Plus accounts, plus a billing system. |

**Read the diagonal.** 4A fits everything about STM *except the business model*. 4B fits
the business model *and nothing else*.

---

## 2. The case for 4A — steelmanned

1. **The moat against the card issuers is genuinely structural.** Ramp requires
   incorporation + ~$25k bank balance; Brex $50k. That's *regulatory underwriting*, not
   pricing. They cannot serve a solo dev on a personal card without becoming a consumer
   fintech. This is the strongest defensive fact in the entire research corpus.
2. **Every asset STM already has points here.** The plugin marketplace, the MIT license,
   the local-first architecture, the existing dashboard (1795 LOC), the schema that
   already carries `plan` / `monthly_cost` / `renews_on`. Nothing needs reversing.
3. **The data-source trilemma is survivable at 4A.** Manual entry is *fine* for a
   menu-bar app. It's only fatal if you promised automation.
4. **Cheap to test and cheap to be wrong.** Weeks, not quarters. No accounts, no
   servers, no compliance, no sales hire.
5. **The prosumer exists.** A dev running Claude Max + ChatGPT Pro + Cursor + Copilot +
   Replit + Perplexity + ElevenLabs is spending $400+/mo and genuinely has sprawl.

**Why it might still fail:** items 1–4 are all reasons it's *cheap and defensible*, and
none is a reason anyone *wants it*. Item 5 is the only demand argument, and it describes
exactly the person who buys Tokens 4 Breakfast for $7.99 — a market that has already
been priced, by a competitor, at roughly nothing.

**The unanswerable question for 4A:** what is the ROI of knowing? Rocket Money works
because it **cancels** things and **negotiates** bills — it returns money. A tracker
that only shows you the number returns a feeling. "You're paying $400/mo for AI" → "yes,
I know." **Tracking without action has no ROI, and at 3–4 subscriptions there's nothing
to act on.**

---

## 3. The case for 4B — steelmanned

1. **The pain is real here and only here.** 30 subscriptions across 12 cards is a
   genuine, felt, recurring problem. §0's arithmetic works *for* 4B.
2. **Someone has budget**, and a budget holder who feels pain is the whole ballgame.
3. **1Password's coverage has a real hole.** They connect to admin APIs *"rather than
   inferring spend from card transactions, invoices, or manual exports"* — deliberately.
   So they see org-scoped API spend, not the card-funded seat someone expensed.
4. **Ramp's gap is packaging, not capability** — their own AI Index already classifies
   "subscriptions vs coding agents vs tokens." But packaging gaps persist for years.
5. **Nobody models Claude Max as a term.** Zero product docs field-wide name it.

**Why it fails anyway:**

- **You'd be selling against free, bundled, and already-trusted.** The 4B buyer with
  this pain already has 1Password or Ramp. Your product must be better than *free and
  already installed* — not merely better.
- **You have no way to reach them.** This is the decisive one. 4B is a sales-led market.
  STM's only channel is a plugin marketplace that this buyer never opens. A dev
  installing a Claude Code plugin is not the person who buys SaaS management.
- **Item 3's hole is one 1Password chose.** Two competent teams (them, SuperPenguin)
  looked at card/invoice inference and declined. Treat that as information about the
  hole's value, not an invitation.
- **The clock.** Ramp went early-access → GA in 3 months. 1Password went contracts →
  shadow-AI → token spend in 18. Brex has pre-announced intent. Any 4B plan must
  out-execute three funded incumbents from a standing start, with no sales motion, while
  reversing three architectural non-goals.

---

## 4. Option C — the question may be wrong

Both branches are attempts to make *subscription tracking* into a business. The evidence
keeps saying that's the weak part, not the segment.

**What STM demonstrably has that nobody else does:**
- A key-injection mechanism **Anthropic documents by name** (`apiKeyHelper` — "for
  dynamic or rotating credentials, such as short-lived tokens fetched from a vault").
- The same mechanism **Infisical independently reinvented and shipped** as Agent Proxy
  (*"The agent never saw the key, so there is nothing to leak"*), with a literal
  `-- claude` wrapper — from a funded vendor with **no interest in the cost half**.
- A working, tested, cross-platform, zero-telemetry implementation, already public.

**That's a validated position in agent credential safety, arrived at independently by
two other parties.** Subscription tracking is the part with a $7.99 comp and three
incumbents. Key safety is the part a funded competitor built in parallel because it's
load-bearing for agentic coding.

**Option C is not "do nothing."** It's: *stop trying to monetize the ledger, and ask
whether the credential layer is the actual product.*

**UPDATE 2026-07-17 — Option C has now been researched and the answer is no.** See
[`option-c-credential-layer.md`](./option-c-credential-layer.md). The mechanism
converged on by Anthropic and Infisical is **real but crowded**: 1Password shipped a GA
agent-credential platform (2026-03-17) with OpenAI/Anthropic/Cursor as partners,
Infisical shipped Agent Vault on a $16M Series A, and Cisco absorbed the closest
analogue (Astrix) into an identity platform. Demand evidence for the *transcript-leak*
surface STM defends is **absent** — the measurable pain is git-commit sprawl (0.08% is
MCP-config), and the platform owner patches its own leaks while documenting the
mechanism for free (`apiKeyHelper`). Verdict: **feature of an NHI/secrets platform, not
a standalone business; weak acqui-hire case** (both incumbents already built it).

### The cross-pass pattern — the thing that actually decides this

Three independent, adversarially-verified research passes now exist, and **they rhyme**:

| Thesis | Pass verdict |
|---|---|
| **Payments** — STM as the way people pay through AI platforms | 🔴 **Walled.** Anthropic Directory §4.A + Stripe use-case exclusion. |
| **Subscription tracking** — the AI-spend ledger | 🟡 **Occupied feature.** 1Password/Ramp/Zylo shipped it free/bundled; individual tier is a $7.99 comp. |
| **Credential safety** — the injection mechanism | 🟡 **Occupied feature.** 1Password/Infisical shipped it; being absorbed into identity platforms. |

**STM keeps landing as a well-built mechanism that is *someone else's feature*, not a
standalone venture.** That is the single most important finding of the entire effort,
and no individual pass shows it — only the three together do.

This is **not** "STM is worthless." It is a sharp, working, MIT-licensed tool with a
genuine architectural edge (command-string substitution has a narrower blast radius than
the incumbents' env-var injection), whose core mechanism Anthropic documents by name. The
honest reframe: **stop trying to make STM a company; decide whether it is worth running
as an excellent open-source tool.** That is a real and respectable answer — just not a
venture-scale one. The only thing that could overturn it is the one input no pass could
supply: real users saying they would pay. Gate 1, now demo-able, is the test.

---

## 5. The test that settles it

Do not decide this from the armchair — including this document. **One test discriminates
between all three options**, and it's cheaper than any of them:

> **Ask ten people where the renewal date would come from.**

- **"I'd type it in"** → the product is a $7.99 menu-bar app. Tokens 4 Breakfast exists.
  **4A is real but tiny. Take Option C seriously.**
- **"Connect my admin API"** → they're an org. **4B is the segment, and you are racing
  1Password with no sales motion.**
- **"Read my email"** → the only mechanism that reaches consumer plans — and it costs
  STM its local-only identity, which is its single uncommoditized asset. **A trade, not
  a win.**
- **"Why would I want that?"** → the honest answer, and the one §0 predicts. **Neither
  segment. Option C or nothing.**

Run this against **both segments** — five 4A, five 4B. It is one question, it takes ten
conversations, and it collapses the decision tree regardless of the answer.

---

## 6. Recommendation

**Do not pick 4B.** It requires reversing three non-goals, building a sales motion from
zero, and beating a free bundled incumbent to a buyer you cannot reach. The pain is real
there and it is not yours to serve.

**Do not commit to 4A either — but test it first**, because it's the only branch where
STM's existing assets have value and the only one that's cheap to be wrong about. Go in
knowing the ceiling is roughly $7.99 and the pain is thin.

**Treat Option C as live.** The strongest fact in this entire corpus is not about
subscriptions: it's that **two independent parties — Anthropic in its docs, Infisical in
its product — converged on STM's credential mechanism.** That is a market signal nobody
asked for and nobody has followed up on. It has had zero research passes, and it is the
only place where STM is demonstrably ahead rather than behind.

**Sequence:** run §5's single question against both segments (one week) → if the answer
is "type it in" or "why would I want that," open the Option C research pass before
writing any code.

---

## 7. What would change this

- **4A becomes real if** the prosumer AI-sprawl population is far larger than the $7.99
  comp implies, **or** if tracking becomes *acting* (cancel, downgrade, switch) — because
  action has ROI and knowing doesn't.
- **4B becomes real if** 1Password's product proves enterprise-locked long-term **and**
  the buyer turns out to be the eng lead rather than IT/finance **and** a
  developer-native channel to that buyer exists. Three conditionals; all must hold.
- **Option C becomes real if** the credential layer has demand that the ledger doesn't —
  entirely untested either way.
- **All three die if** the answer to §5 is "why would I want that."
