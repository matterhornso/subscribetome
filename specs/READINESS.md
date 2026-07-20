# Beta readiness — go/no-go

**Status:** review-ready. **Last updated:** 2026-07-18
**Basis:** a 5-dimension readiness audit (onboarding, new-feature robustness, security,
docs accuracy, cross-platform), each run as an independent agent against the merged
product (`2d8bac4`). Safe fixes applied on branch `fix/beta-readiness`. **Nothing was
merged or published while you were away** — this is a review-and-click summary.

---

## Verdict

**Not ready for an unqualified all-platform public beta. Ready for a scoped macOS +
Claude Code beta** once you (a) run two quick verifications and (b) make two scope
calls. The safe hardening is already done and staged as a PR.

The reason it's a scope decision, not a build: the gaps that remain are **real-hardware
verification** (which needs your machines / community, not code) and **product
judgment** (which is yours). Everything that could be fixed from the keyboard, is.

---

## What I fixed (branch `fix/beta-readiness`, staged as a PR — not merged)

All verified: **397 unit tests + 22 UI tests pass**, and the light theme was visually
confirmed via screenshot.

| Fix | Severity | Note |
|---|---|---|
| Light theme unreadable on Projects/Browse/sync-log | HIGH | Hardcoded dark boxes → semantic tokens. Dark mode unchanged; light mode confirmed readable. |
| Dashboard edits silently wiped `billing_cadence` | MED | Daemon now read-merges omitted fields. |
| `--cost abc` stored NaN | MED | Rejected now. |
| DB file was `0600`-worthy but `0644` | LOW (security) | Now `0600` — it holds card last-4 + nicknames. |
| SECURITY.md "Nothing is sent anywhere" (false) | **BLOCKER (docs)** | Contradicted `stm sync`. Corrected. |
| Shipped feature undocumented (cards/themes/`stm subscription`) | HIGH (docs) | CHANGELOG + DOCS.md + SECURITY.md now cover it. |
| "macOS Keychain" in the install card | HIGH (docs) | → "OS keychain". |
| No theme regression test | — | Added; also emits light+dark screenshots of every tab. |

Screenshots for your eyeball: `/tmp/stm-ui-test-{light,dark}-{keys,projects,policy,import}.png`
(regenerate any time with `node tests-ui/run.mjs`).

---

## Confirmed SAFE — no action needed

The audit tried to break these and couldn't. Worth knowing they're solid:

- **Security model holds.** The security dimension's verdict, verbatim: *"safe to put in
  front of the public as a beta, security-wise."* Zero third-party dependencies, no
  `postinstall`; key values never touch the DB / transcript / argv; audit log stores the
  placeholder not the substituted command; daemon is token + Host/Origin gated;
  DNS-rebinding defended. One MEDIUM footgun (`stm hook pretooluse` run by hand is a
  substitution oracle) — it requires an already-compromised model and is audited; worth
  a `SECURITY.md` note but not a launch blocker.
- **No XSS.** Every free-text field (card nickname, plan, project name, audit reason) is
  escaped.
- **Full-PAN guard is complete.** A card number that isn't exactly 4 digits is rejected
  at every write path (store, CLI, daemon). Cardholder data cannot reach the DB.
- **The `bin/stm` / bare-`stm` design is correct.** The onboarding audit flagged
  "`stm` not on PATH → fails on first keystroke" as a *possible* blocker but couldn't
  verify it. It's a **false alarm**: per the official Claude Code plugin docs, a
  plugin's `bin/` directory is auto-added to the Bash tool's PATH, and `bin/stm` is
  executable. Bare `stm` resolves for an installed+enabled plugin. (It only fails in the
  dev checkout, which isn't an installed plugin.)

---

## Before you launch — 2 verifications (≈30 min, needs you)

These are cheap and I could not do them from here:

1. **Real-install smoke test (highest priority).** On a clean machine / profile:
   install the plugin per the README, restart Claude Code, run `/stm:dashboard`, add a
   key, and use it in a real Bash command. Confirm bare `stm` resolves and the
   PreToolUse injection fires. This is the one path the whole product rests on, and it's
   only truly provable from an installed plugin — not the dev checkout. All static
   evidence says it works; confirm it once.
2. **Eyeball the light theme.** Open the screenshots above, or `bun src/cli.ts dashboard`
   and toggle ☀/☾. The Projects tab (the one that was broken) is confirmed fixed; give
   the rest a look.

---

## Before you launch — 2 scope decisions (yours)

The cross-platform audit's clear recommendation, which I agree with:

**Decision A — platform scope.** Recommended: **macOS + Claude Code for the first public
beta.**
- **macOS + Claude Code** — ready (pending the smoke test).
- **Linux** — close, but the dashboard opener is macOS-only (`spawnSync("open")` in
  `daemon.ts`) so the browser never opens, and no keystore tier has a real-hardware
  pass. A small fix (reuse the platform-branching opener already in `cli.ts` for
  `stm rotate`) unblocks it — but it touches the token-delivery security posture (how a
  headless user gets the token URL), so I left it for you rather than change that
  unsupervised. Good candidate for a **second wave**.
- **Windows** — not ready. The Claude Code hook is a bash script; on native Windows
  (no WSL/git-bash) it silently doesn't fire — the core feature fails open. And there's
  no `stm` launcher for cmd/PowerShell. Present as **"experimental, help wanted."**

**Decision B — Codex labeling.** Both Codex modes are smoke-tested only, against external
contracts (Codex's env-policy and trust-gate) that aren't verified on real hardware.
The code is careful and honest (it already tells users Codex is weaker than Claude Code).
Recommended: ship Codex **behind an explicit "experimental" label**, not at parity.

---

## Worth doing, not blocking (I can do these on request)

- **Extend `stm doctor`** to check the hook is registered + executable, `bun` resolves,
  the daemon is live, and the DB opens. Today it only reports keystore tiers — so the
  #1 likely support ticket ("I added a key but the agent still sees the placeholder") is
  invisible to it. Highest-leverage support-load reducer; ~an hour.
- **Recapture the landing-page screenshots** (they predate the card columns + theme).
  I generated fresh ones in the UI run; wiring them into `docs/` needs your call on the
  landing page.
- **README** doesn't yet mention subscriptions/cards/themes (DOCS.md now does).
- Security nice-to-haves: strip the dashboard token from the URL after load
  (`history.replaceState`), add a CSP header, `SECURITY.md` note about
  `stm hook pretooluse`, optional reject-a-PAN-in-the-nickname guard.
- **Bump the version** off `1.0.0` when you cut the release (the changelog entry is
  currently under `[Unreleased]`).

---

## Explicitly NOT done while you were away (on purpose)

- **Nothing merged.** Both branches (`fix/beta-readiness`, and the earlier
  `feat/…`-derived work) are staged for your review.
- **Nothing published** — no marketplace release, no npm, no announcement, none of the
  `marketing/` drafts posted, no deploy to the live site. Launching a public beta is
  your call, especially given the strategic questions in `segment-decision.md` and
  `option-c-credential-layer.md` are unresolved.
- **No invariant reversed.** Still local-only, zero-telemetry. No accounts, no sync, no
  money movement were added.
- The **Linux dashboard-opener fix** and any **credential-token-delivery** change were
  left for you — they touch security posture and I won't change that unsupervised.
