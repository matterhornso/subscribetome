# Gate 1 — demand test script

**Purpose:** decide whether to build Phase 1 of [`public-product.md`](./public-product.md).
**Status:** ⚠️ **HOLD — do not run yet.** **Last updated:** 2026-07-17

> **Two things must be settled before this script is worth running** (see
> [`public-product.md`](./public-product.md) §2.5.1 and §3.4):
> 1. **The segment.** 4B (teams) is occupied — 1Password shipped AI spend there on
>    2026-07-14, free and bundled; Ramp GA'd 2026-07-16. The only structurally
>    defensible ground is 4A (individuals), which was ruled out. Interviewing a segment
>    that's already occupied wastes the two weeks.
> 2. **The data source.** Nobody has answered where a renewal date would come from for
>    an individual Claude Max subscriber — there is no consumer billing API. §5A below
>    now carries this question; it gates the build harder than demand does.
>
> Interview **both segments** and let the answers pick, rather than defending a choice
> made before the competitive sweep.

Gate 0 established that STM *may* build the AI subscription ledger — the platform
terms permit it, the mechanism is endorsed, and no vendor tracks it. Gate 1 asks the
only remaining question: **does anyone want it.**

This script exists because badly-run customer interviews are worse than none. They
manufacture false positives, and a false positive here costs months.

---

## The one rule

**Never ask "would you use this?"** It gets you politeness. Every question below asks
about the **past** or the **present**, never the hypothetical future. People are
unreliable narrators of what they *would* do and reliable reporters of what they
*did*.

Corollary: **do not describe STM until the interview is over.** The moment they know
what you're selling, they start being nice to you. Everything after that is
contaminated.

---

## Who to talk to

Per decision 4B: **teams/startups where a budget holder exists.** Not solo devs —
Cledara's pricing (every tier indexed to 25+ staff, no solo tier) is evidence the
economics don't close below team scale.

Target the person who would *feel* the pain:
- eng lead / CTO at a 10–50 person startup
- whoever gets asked "why is our AI bill $X this month"
- ideally NOT the finance person — if this is only a finance problem, that's a
  finding (see §Bear case)

Ten conversations. Fewer is noise.

---

## The script

### 1. Establish the ground truth (5 min)

- "Walk me through the AI tools your team pays for right now."
  *(Let them list. Count how long it takes and how much they hesitate. Hesitation is
  the signal — if they can rattle it off, there's no problem here.)*
- "Who bought each one?"
- "How did you find that out just now — did you know, or would you have to check?"
- "When did you last get surprised by an AI bill?" → **if yes, go deep. This is the
  whole interview.** What happened? What did it cost? What did you do about it?

### 2. Find the existing workaround (5 min)

Anything real has a workaround. If there's no workaround, there's no pain.

- "What do you use today to keep track of it?"
- "Show me?" *(A spreadsheet is a finding. A spreadsheet someone maintains weekly is
  a strong finding. "Nothing" is a finding too — usually meaning it doesn't hurt.)*
- "Who maintains it? How often? What happens when they don't?"
- "What did you try before that? Why did you stop?"

### 3. Price the pain (5 min)

- "Last time this went wrong, what did it cost — money, or time, or both?"
- "Has anyone ever paid for a tool nobody was using? How long before you noticed?"
- "Roughly what fraction of your AI spend could you not account for right now?"

### 4. Test the bear case — the FinOps question (5 min)

Gate 0.1 established the real competitor is the FinOps layer, not Claude Code.
Anthropic exports usage to Datadog/CloudZero and treats aggregation as a *partner*
surface. So the question is not "would you use a dev tool for this" — it's:

- "Do you have a FinOps or spend-management tool? Ramp, Brex, Vendr, Zylo, Torii?"
- **"Why isn't this already in there?"** ← the most important question in the script
- **"Do you use 1Password?"** → if yes: *"they shipped AI spend tracking last week,
  free, in SaaS Manager. Would you use that?"* **This is the sharpest test in the
  script** — it's a real, free, shipped, bundled alternative from a vendor they already
  trust. If the answer is "yes, obviously," 4B is closed.
- "If your finance team can already see the card charges, what's missing for you?"
- "Whose job is it to know this — yours or finance's?"

**If the honest answer is "finance handles it in Ramp and that's fine," the wedge is
occupied — just not by a dev tool.** That is a result. Write it down and move on.
Do not argue with it.

### 5A. The data-source question — ask this even if everything else fails (3 min)

The hardest unsolved problem in the plan (§3.4). There is **no consumer billing API**
that exposes "$200/mo, renews the 14th" for an individual Claude Max seat. So:

- "If a tool showed you every AI subscription with its renewal date — **where do you
  think it would get the renewal date from?**"
- "Would you type it in? Would you keep typing it in every time something changed?"
- "Would you connect your email so it could read the receipts?" ← **watch their face.**
  This is the only mechanism that reaches consumer plans, and it costs STM its
  "local-only, zero-telemetry" identity. If they flinch, that path is closed too.

**Ten "I'd type it in" answers means the product is a $7.99 menu-bar app — and Tokens 4
Breakfast already ships it.**

### 5. Only now, if you must (last 5 min)

After you've got everything above and the recorder is metaphorically off:

- "We've been thinking about X. What would have to be true for that to be useful?"
- Then **shut up.** Their first objection is worth more than their enthusiasm.

---

## Scoring

Set before the first call, so we can't move it afterwards.

**The bar: if fewer than 3 of 10 describe this — unprompted, in §1 or §2 — as a real
recurring problem, do not build.**

"Unprompted" is load-bearing. It does not count if they agree it's a problem after
you raise it. Everyone agrees with everything after you raise it.

Log per conversation:
| Field | |
|---|---|
| Could they list their AI tools from memory? | Y/N |
| Have they been surprised by a bill? When? Cost? | |
| Existing workaround (spreadsheet / nothing / tool) | |
| Who maintains it, how often | |
| Do they have a FinOps tool? Why isn't this in it? | |
| Use 1Password? Would the free bundled version do? | Y/N |
| **Where would the renewal date come from?** | type-it-in / API / email |
| Would they connect email for receipt parsing? | Y/N |
| **Unprompted pain?** | **Y/N** ← the only one that counts |

---

## Bear case — the thing most likely to be true

The research verifiers flagged it and nobody has tested it:

> **A uniform absence across vendors may indicate low demand rather than an unserved
> need.**

Nobody tracks AI subscriptions + renewals + cards. The *optimistic* reading is that
it's an architectural blind spot — gateways only see proxied traffic, so they
structurally cannot see OAuth-authed seats. The *pessimistic* reading is that it's
unserved because nobody cares enough to pay.

Both readings explain the evidence equally well. **Gate 1 is the only thing that
separates them.** Go in genuinely willing to hear the pessimistic answer, or don't
bother going in.

---

## What a "no" gets you

A no is worth running. If the answer is that AI subscription sprawl isn't a real
problem for teams, that's a two-week finding instead of a six-month one — and STM
remains what it already is: a well-built, working, MIT-licensed key-safety tool whose
core mechanism Anthropic documents by name (`apiKeyHelper`). That is not a failure
state.
