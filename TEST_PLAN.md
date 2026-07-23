# subscribetome — Full Functional Test Plan

**Target:** `v1.1.0-beta.1` (`main` @ current HEAD). **Scope:** every page, control,
CLI command, hook, and security invariant of the platform. Each case is written so a
tester can execute it as a user and judge pass/fail against a concrete expected result.

## How to run

- **CLI cases** (`CLI-*`, `HOOK-*`, `SEC-*`): run against a throwaway store so the real
  keychain/DB is never touched:
  ```
  export STM_KEYCHAIN_SERVICE=subscribetome-qa STM_DB=/tmp/stm-qa.sqlite
  bun src/cli.ts <cmd>
  ```
  Feed hooks via `printf '<json>' | bun src/cli.ts hook <name>`. Assert on stdout/stderr
  **and exit code**. Never run bare `add`/`rotate`/`sync`/`dashboard`/`daemon`/
  `uninstall`(non-dry)/`vault import|export|rotate`/`codex`(non-dry) against real state.
- **Dashboard cases** (`DSH-*`): drive the live daemon the same way `tests-ui/run.mjs`
  does — it spins up a sandbox daemon over a sandbox keystore + seeded DB and writes the
  tokenised URL to `/tmp/stm-ui-url.txt`. Execute via Playwright (extend
  `tests-ui/dashboard.suite.mjs`). "Act as a user": click the real control, then assert
  the resulting DOM change **and** the network call it fired.
- **HTTP posture cases** (`API-*`): raw `fetch` against the daemon, no browser.
- **End-to-end core-promise proof**: `node tests-ui/e2e-core-promise.mjs` (macOS) — enters a fake key once, has the PreToolUse hook inject it into a real `curl` to a localhost mock service, and proves the service receives the real key with no re-paste/rotate and no leak into the DB/audit. Covers SEC-04/05 + HOOK-PRE-01 end-to-end over a live socket.

Legend for **Channel**: `bash` = CLI/hook via shell; `pw` = Playwright browser; `http` = raw fetch.
Legend for **Pri**: P1 = core path / security; P2 = important; P3 = edge/polish.

---

## A. Dashboard — Header & global mechanics  (Channel: pw/http)

| ID | Pri | Precondition | Steps | Expected |
|----|----|----|----|----|
| DSH-H-01 | P1 | Daemon up, valid token | Load `/` with `?token=` | Page renders; Keys tab active; no console errors |
| DSH-H-02 | P1 | — | Load `/` **without** token | 403 (not the HTML) |
| DSH-H-03 | P2 | Seeded inv | Read `#keystore-label` | Shows active keystore (e.g. "macOS Keychain"); `title` = "Keys live in: …" |
| DSH-H-04 | P2 | Seeded inv | Read `#agents-label` | Shows `agents: <labels>`; tooltip present; hidden if list empty |
| DSH-H-05 | P2 | Seeded inv, no fetched spend | Read `#spend` | `$0.00` by default; `.toFixed(2)` format |
| DSH-H-06 | P2 | Manual costs only | Read `#spend-source` pill | Reads "self-reported" (manual>0, fetched=0) |
| DSH-H-07 | P1 | — | Read `#sync-btn` text | Exactly `Fetch live spend` |
| DSH-H-08 | P2 | No providers configured | Click `#sync-btn` | Button disables → "Syncing…"; sync-log opens; POST `/api/spend/sync` `{}`; per-provider `[skip] not configured` lines; button re-enables + label restored |
| DSH-H-09 | P3 | Force sync throw (bad provider state) | Click sync | `[fail]` log line + toast "Sync failed: …"; button restored (no stuck disabled state) |
| DSH-H-10 | P2 | — | Any mutation → toast | Toast appears bottom-center, auto-hides ~1.9s |
| DSH-H-11 | P1 | — | Confirm no outbound network fires except on Fetch-live-spend click | Loading page / switching tabs / adding keys triggers **no** external host calls |

## B. Dashboard — Keys tab  (Channel: pw)

### B1. Add keys card
| ID | Pri | Precondition | Steps | Expected |
|----|----|----|----|----|
| DSH-K-01 | P1 | Keys tab | Inspect section order | Add keys → API keys → Browse services → Subscriptions |
| DSH-K-02 | P1 | — | Open `#svc` select | 50 catalog services + trailing "Other (custom)" (51 options total) |
| DSH-K-03 | P2 | — | Pick a catalog service | `#svc-fields` shows one password input per credential, labelled `<name> · <label>` |
| DSH-K-04 | P2 | — | Pick "Other (custom)" | Shows `#o-tool`, `#o-label` (default "default"), `#o-value` |
| DSH-K-05 | P2 | Catalog svc selected | Click "+ Add another field" | Appends a `.cf-row` (label + value + ✕); ✕ removes it |
| DSH-K-06 | P1 | Other selected, tool+value filled | Click Add | POST `/api/keys`; success "Added <chip>"; inventory refreshes with new row; inputs cleared |
| DSH-K-07 | P1 | Other selected, value blank | Click Add | Client blocks: "Tool and secret value are required." — no POST |
| DSH-K-08 | P2 | Catalog svc, all fields blank | Click Add | Client blocks: "Fill at least one field." |
| DSH-K-09 | P1 | Add a key whose label already exists | Click Add | Per-item failure surfaced: `…already exists for…`; not silently dropped |
| DSH-K-10 | P2 | First key + Plan/Cost/Renews filled | Click Add | Tool metadata upserted (plan/cost/renews visible in Subscriptions) |
| DSH-K-11 | P3 | Cost field | Enter non-numeric via keyboard | `type=number` guards; server rejects NaN if forced |

### B2. API keys inventory table
| ID | Pri | Precondition | Steps | Expected |
|----|----|----|----|----|
| DSH-K-12 | P1 | Seeded keys | Read table | Columns Placeholder/Status/Source/Added; 6 seeded rows |
| DSH-K-13 | P1 | — | Click a placeholder `code.copy` | Clipboard gets `{{stm:tool:label}}`; toast "Copied …" |
| DSH-K-14 | P1 | Active key row | Click Revoke | POST `/api/keys/revoke`; row flips to `revoked`; Revoke button gone |
| DSH-K-15 | P2 | Revoked key | Inspect | No Revoke button rendered for `revoked` status |
| DSH-K-16 | P2 | Empty inventory | Load | "No keys yet — add one above." (colspan 5) |

### B3. Browse services
| ID | Pri | Precondition | Steps | Expected |
|----|----|----|----|----|
| DSH-K-17 | P1 | Fresh localStorage | Load Keys tab | Browse services **collapsed** by default |
| DSH-K-18 | P2 | Collapsed | Click `#browse-head` | Expands; caret rotates; persists to `stm-browse-open` |
| DSH-K-19 | P2 | Expanded | Reload | Still expanded (persisted) |
| DSH-K-20 | P2 | Expanded | Read categories | Rendered in CATEGORY_ORDER; empty categories skipped |
| DSH-K-21 | P1 | Expanded | Click a `.svc-tile` | Opens provider URL in new tab (noopener); sets `#svc`; renders fields; scrolls to + flashes Add-keys card |

### B4. Subscriptions table
| ID | Pri | Precondition | Steps | Expected |
|----|----|----|----|----|
| DSH-K-22 | P2 | Seeded tools | Read table | Columns Tool/Plan/Monthly/Card/Renews |
| DSH-K-23 | P1 | A tool row | Click Edit | Row becomes inline form (plan, cost, card-nick, card-last4[maxlen4], renews, Save/Cancel) |
| DSH-K-24 | P1 | Editing | Set last4=1234, nick, Save | POST `/api/tools/subscription`; toast "Subscription updated"; Card cell shows `Nick ••1234` |
| DSH-K-25 | P1 | Editing | Set last4=`4111111111111111`, Save | Rejected (400): "card_last4 must be exactly 4 digits" surfaced to `#add-msg`; **no full PAN stored** |
| DSH-K-26 | P2 | Editing | Click Cancel | Reverts to display row, no write |
| DSH-K-27 | P2 | Editing, clear only some fields | Save | Read-merge: omitted fields preserved; explicit-blank clears (e.g. last4="" clears card) |
| DSH-K-28 | P2 | Renews within 14d | Read Renews cell | Shows "in Nd"/"today"/"overdue" badge correctly |
| DSH-K-29 | P2 | Empty subs | Load | "No subscriptions tracked yet." (colspan 6) |

## C. Dashboard — Projects tab  (Channel: pw)

| ID | Pri | Precondition | Steps | Expected |
|----|----|----|----|----|
| DSH-P-01 | P2 | Seeded project | Read row | Name, ellipsized path, scope pills (or "no keys scoped yet") |
| DSH-P-02 | P1 | Row | Enforce toggle geometry | Toggle right edge ≤ Edit-scope left edge (no overlap) |
| DSH-P-03 | P1 | Row | Click Enforce toggle | Visual flips; POST `/api/projects/:id/enforce`; toast "Enforcement ON/OFF" |
| DSH-P-04 | P1 | Row | Click Edit scope | Expands checklist of active keys, prechecked if in scope; button label → "Done" |
| DSH-P-05 | P1 | Scope checklist | Check an unscoped key | POST `/api/projects/:id/scope`; pill appears |
| DSH-P-06 | P1 | Scope checklist | Uncheck a scoped key | DELETE `/api/projects/:id/scope`; pill removed |
| DSH-P-07 | P2 | Scope pill | Click pill | Copies placeholder to clipboard |
| DSH-P-08 | P1 | Row | Click Remove → confirm | DELETE `/api/projects/:id`; toast "Project removed"; row gone |
| DSH-P-09 | P2 | Remove | Dismiss confirm | No deletion |
| DSH-P-10 | P1 | Add form, path+name | Click Add | POST `/api/projects`; "Project added."; inputs cleared; row appears |
| DSH-P-11 | P1 | Add form, one field blank | Click Add | Client blocks: "Path and name are both required." |
| DSH-P-12 | P2 | Add form, Name field | Press Enter | Submits (same as Add) |
| DSH-P-13 | P2 | No projects | Load | "No projects registered. Add one below…" |
| DSH-P-14 | P2 | Load with `?from=<matching cwd>` | Read session signal | "Session in **name** · N keys in scope · path" + Edit-scope pill |
| DSH-P-15 | P2 | Load with `?from=<unmatched cwd>` | Read session signal | "no project matches…" + "Create project from this path" button |

## D. Dashboard — Policy & audit tab  (Channel: pw)

### D1. Policy rules
| ID | Pri | Precondition | Steps | Expected |
|----|----|----|----|----|
| DSH-D-01 | P2 | Seeded rule | Read table | Columns Order/Key/Command/Agent/Action/Reason; blanks show `*` |
| DSH-D-02 | P1 | Add form: action=Deny, key glob | Click Add | POST `/api/policies`; "Added rule #id (order N)"; row appears; form resets (order→100, action→deny) |
| DSH-D-03 | P1 | Rule row | Click Remove → confirm #id | DELETE `/api/policies/:id`; toast "Rule #id removed"; row gone |
| DSH-D-04 | P3 | Add form, order non-numeric (forced) | Add | Server 400 surfaced |
| DSH-D-05 | P2 | No rules | Load | "No policy rules. Default action when no rule matches is allow." |

### D2. Test a command
| ID | Pri | Precondition | Steps | Expected |
|----|----|----|----|----|
| DSH-D-06 | P1 | Deny rule on `stripe:*` | Test `echo {{stm:stripe:default}}` | Verdict card = DENY, shows rule #, reason, per-substitution list |
| DSH-D-07 | P2 | — | Test `echo hello` (no placeholder) | Verdict ALLOW + note "No stm placeholders … policy not consulted." |
| DSH-D-08 | P2 | — | Test with blank input | Client blocks: "Enter a command to test." |
| DSH-D-09 | P2 | — | Press Enter in test input | Runs test (same as button) |

### D3. Recent decisions (audit)
| ID | Pri | Precondition | Steps | Expected |
|----|----|----|----|----|
| DSH-D-10 | P2 | Some audit rows | Read table | Columns Time/Event/Key/Info; event badges colored; key as placeholder or `—` |
| DSH-D-11 | P2 | — | Change event filter | Refetches `/api/audit?event=…`; rows filtered |
| DSH-D-12 | P2 | — | Type tool filter + Enter | Filters by tool |
| DSH-D-13 | P2 | — | Click Refresh | Re-fetches audit |
| DSH-D-14 | P1 | Rows present | Click Clear log → confirm | POST `/api/audit/clear`; toast "Cleared N rows"; table empties |
| DSH-D-15 | P2 | No rows | Load | "No audit rows. Run a command with an stm placeholder…" |

## E. Dashboard — Import tab  (Channel: pw)

| ID | Pri | Precondition | Steps | Expected |
|----|----|----|----|----|
| DSH-I-01 | P2 | Dir with a `.env` holding a key | Enter dir, Scan | POST `/api/import/scan`; "Found N candidate(s)…"; table shows Variable/Value(masked)/Tool/Label/Import(checked) |
| DSH-I-02 | P2 | Dir with no keys | Scan | "No candidate keys found in .env files under that directory." (table hidden) |
| DSH-I-03 | P2 | Blank dir | Scan | Client blocks: "Enter a directory to scan." |
| DSH-I-04 | P1 | Scanned rows, some checked | Import selected | POST `/api/import/confirm`; "Imported N key(s)"; keys appear in inventory |
| DSH-I-05 | P2 | Scanned, none checked | Import | Client blocks: "Nothing selected." |
| DSH-I-06 | P1 | Import value | Verify masking | Raw secret value never sent to browser (only `valueMasked`); confirm reads server-side |
| DSH-I-07 | P3 | Import triggers scope suggest | Read banner | "suggest-create" green banner with Create-project button works |

## F. Dashboard — Theme & navigation  (Channel: pw)

| ID | Pri | Precondition | Steps | Expected |
|----|----|----|----|----|
| DSH-T-01 | P1 | Fresh | Load | Pre-paint sets `data-theme` (localStorage → system → dark) with no flash |
| DSH-T-02 | P1 | — | Click `#theme-btn` | `data-theme` flips light↔dark; body background changes; glyph swaps ☀/☾ |
| DSH-T-03 | P1 | Toggled | Reload | Chosen theme persists (`stm-theme`) |
| DSH-T-04 | P1 | Light theme | Eyeball every tab | All surfaces readable — no dark-on-dark boxes (Projects/Browse/sync-log especially) |
| DSH-T-05 | P1 | — | Click each tab | Correct panel shows, others hidden; `aria-selected` set |
| DSH-T-06 | P2 | On Projects tab | Reload | Active tab persists (`stm-tab`) |

## G. Dashboard — HTTP / security posture  (Channel: http)

| ID | Pri | Steps | Expected |
|----|----|----|----|
| API-01 | P1 | `GET /api/health` no token | 200 `{ok:true}` |
| API-02 | P1 | `GET /api/inventory` no token | 401 |
| API-03 | P1 | `GET /api/inventory?token=<valid>` | 200 |
| API-04 | P1 | `GET /api/inventory?token=<valid>` with `Host: evil.example.com` | 403 (DNS-rebind defense) |
| API-05 | P1 | `GET /` no token | 403 |
| API-06 | P2 | `GET /api/inventory?token=WRONG` | 401 |
| API-07 | P2 | Any response | Security headers present (`:96-100`) |
| API-08 | P2 | `POST /api/keys` missing tool/value | 400 |
| API-09 | P2 | `DELETE /api/policies/:id` unknown id | 404 "no such policy" |
| API-10 | P2 | `POST /api/tools/subscription` last4 not 4 digits | 400 (PAN guard) |
| API-11 | P3 | `GET /api/audit?event=bogus` | 400 "unknown event class" |
| API-12 | P3 | `POST /api/spend/sync {provider:"bogus"}` | 400 unknown provider |

## H. CLI commands  (Channel: bash)

### H1. add / subscription / list
| ID | Pri | Command | Expected |
|----|----|----|----|
| CLI-ADD-01 | P1 | `add` (no `--tool`) | usage to stderr, exit 1 |
| CLI-ADD-02 | P1 | `printf '' \| add --tool x` (empty stdin) | `error: no key value received on stdin`, exit 1 |
| CLI-ADD-03 | P1 | `printf 'sk-xxx' \| add --tool openai` | `added {{stm:openai:default}}` + hint, exit 0; value only in keystore, never argv |
| CLI-ADD-04 | P2 | add duplicate label | `error: a key labelled "…" already exists…`, exit 1 |
| CLI-ADD-05 | P2 | `add --tool x --cost abc` | `--cost must be a number (got "abc")`, exit 1 |
| CLI-ADD-06 | P2 | `add --tool 'My Tool!'` | tool normalized to `my-tool-` (lowercase, non-alnum→`-`) |
| CLI-SUB-01 | P1 | `subscription mytool --plan pro --cost 20 --card-nickname Amex --card-last4 4321` | `updated mytool: pro, $20/mo, card Amex ••4321, renews -`, exit 0 |
| CLI-SUB-02 | P1 | `subscription mytool --card-last4 4111111111111111` | `error: card_last4 must be exactly 4 digits (stm never stores a full card number)`, exit 1 |
| CLI-SUB-03 | P2 | `subscription nope` (unknown, no upsert flags) creating vs existing | upserts tool; unknown-only path → tool created; `setSubscription` false → `no such tool` |
| CLI-SUB-04 | P2 | `subscription mytool --card-last4 ""` | clears card |
| CLI-SUB-05 | P2 | `subscription` (no tool) | usage exit 1 |
| CLI-LS-01 | P1 | `list` on empty store | `No tools or keys yet.` + 2 hints, exit 0 |
| CLI-LS-02 | P1 | `list` with keys+subs | API KEYS + SUBSCRIPTIONS tables + total spend; RENEWS SOON table if due ≤14d |

### H2. resolve / revoke / rotate
| ID | Pri | Command | Expected |
|----|----|----|----|
| CLI-RES-01 | P1 | `resolve {{stm:openai:default}}` piped (non-TTY) | Refuses: "only runs in an interactive terminal…", exit 1 — **never prints key to a pipe** |
| CLI-RES-02 | P2 | `resolve badformat` | usage, exit 1 |
| CLI-REV-01 | P1 | `revoke openai default` (exists) | `revoked openai:default`; subsequent resolve → null |
| CLI-REV-02 | P2 | `revoke nope nope` | stderr `no such key: nope:nope`, exit 1 |
| CLI-REV-03 | P2 | `revoke` (<2 args) | usage exit 1 |
| CLI-ROT-01 | P2 | `rotate openai default --no-open` piped new value | repoints to new value, status active, placeholder unchanged (use throwaway store) |
| CLI-ROT-02 | P2 | `rotate` on revoked key | refuse, exit 1 |
| CLI-ROT-03 | P2 | `rotate` new value = `{{stm:...}}` | refuse "looks like a placeholder", exit 1 |

### H3. policy
| ID | Pri | Command | Expected |
|----|----|----|----|
| CLI-POL-01 | P1 | `policy list` empty | `No policy rules.` + hint, exit 0 |
| CLI-POL-02 | P1 | `policy add --then deny --when-key 'stripe:*' --reason x` | `added policy #N (order 100): …→ deny (x)`, exit 0 |
| CLI-POL-03 | P1 | `policy add` (no `--then`) | usage exit 1 |
| CLI-POL-04 | P2 | `policy add --then deny --order abc` | `error: --order must be a number`, exit 1 |
| CLI-POL-05 | P1 | `policy test 'echo {{stm:stripe:default}}'` (deny rule present) | `Verdict: DENY (rule #N)` + reason + per-substitution, exit 0 |
| CLI-POL-06 | P2 | `policy test 'echo hi'` | `No stm placeholders … Verdict: allow.`, exit 0 |
| CLI-POL-07 | P2 | `policy remove 999` | `no such policy: #999`, exit 1 |
| CLI-POL-08 | P2 | `policy bogus` | stderr + help, exit 1 |

### H4. audit
| ID | Pri | Command | Expected |
|----|----|----|----|
| CLI-AUD-01 | P1 | `audit` empty | `No audit rows.`, exit 0 |
| CLI-AUD-02 | P2 | `audit --event bogus` | error listing valid classes, exit 1 |
| CLI-AUD-03 | P2 | `audit --since 9x` | invalid duration error, exit 1 |
| CLI-AUD-04 | P2 | `audit --tail 0` | error, exit 1 |
| CLI-AUD-05 | P2 | `audit prune` (neither/both `--before`/`--keep`) | usage exit 1 |
| CLI-AUD-06 | P2 | `audit clear` non-TTY | clears immediately (guard only in TTY); prints `cleared N rows` |

### H5. doctor / status / stop / version / help
| ID | Pri | Command | Expected |
|----|----|----|----|
| CLI-DOC-01 | P1 | `doctor` (macOS) | `✓ Tier 1 — macOS Keychain (active)`, exit 0 |
| CLI-STA-01 | P2 | `status` | daemon/keystore/agents/keys/tools/spend summary, exit 0 |
| CLI-STOP-01 | P2 | `stop` (not running) | `daemon not running`, exit 0 |
| CLI-VER-01 | P1 | `--version` | `stm 1.1.0-beta.1`, exit 0 |
| CLI-HELP-01 | P2 | `boguscmd` | stderr `stm: unknown command "boguscmd"` + help, exit 1 |
| CLI-HELP-02 | P3 | `--help` | top-level help, exit 0 |

### H6. project
| ID | Pri | Command | Expected |
|----|----|----|----|
| CLI-PRJ-01 | P1 | `project add /tmp/qa-proj Acme` | `added project #N "Acme" at /tmp/qa-proj`, exit 0 |
| CLI-PRJ-02 | P2 | `project add` duplicate path | `error: a project at "…" already exists…`, exit 1 |
| CLI-PRJ-03 | P2 | `project list` empty | `No projects.` + hint |
| CLI-PRJ-04 | P2 | `project scope /tmp/qa-proj openai:default` | `scoped openai:default to "Acme"` |
| CLI-PRJ-05 | P2 | `project enforce /tmp/qa-proj on` (empty scope) | warns "every placeholder will be denied" |
| CLI-PRJ-06 | P2 | `project unscope` not-in-scope | `…is not in "…" scope (nothing to do)`, exit 1 |
| CLI-PRJ-07 | P2 | `project rename /tmp/qa-proj New` | `renamed #N "Acme" → "New"` |
| CLI-PRJ-08 | P2 | `project remove /tmp/qa-proj` | `removed project #N "…"` |
| CLI-PRJ-09 | P3 | `project scope … badformat` | parseToolLabel error, exit 1 |

### H7. import / vault / codex / uninstall
| ID | Pri | Command | Expected |
|----|----|----|----|
| CLI-IMP-01 | P2 | `import /tmp/emptydir` | `No candidate keys found…`, exit 0 |
| CLI-IMP-02 | P2 | `import <dir with .env>` | lists candidates (var, kind, masked value, suggested placeholder), exit 0 |
| CLI-VLT-01 | P2 | `vault info` (no vault) | `exists: no`, exit 0 |
| CLI-VLT-02 | P3 | `vault export` (no arg) | usage exit 1 |
| CLI-CDX-01 | P2 | `codex --help` | codex help, exit 0 |
| CLI-CDX-02 | P2 | `codex --dry-run` | injection plan + "(dry run — codex was NOT launched…)", exit 0 |
| CLI-CDX-03 | P2 | `codex install-hooks --dry-run` | prints would-be `~/.codex/config.toml` block, no write, exit 0 |
| CLI-CDX-04 | P2 | `codex doctor` (nothing installed) | reports both tracks missing, exit 1 |
| CLI-UNI-01 | P1 | `uninstall --dry-run` | enumerates plan + "Not affected"; `(dry-run) — no changes made.`, exit 0 — **nothing deleted** |

## I. Hooks  (Channel: bash — `printf '<json>' \| bun src/cli.ts hook <name>`)

### I1. PreToolUse
| ID | Pri | Input | Expected |
|----|----|----|----|
| HOOK-PRE-01 | P1 | Bash cmd with valid placeholder, key exists | stdout JSON `permissionDecision:allow` + `updatedInput.command` with real value swapped; exit 0; one `substitute` audit row |
| HOOK-PRE-02 | P1 | Bash cmd, unknown placeholder `{{stm:ghost:nope}}` | block (exit 2) "cannot resolve placeholder(s)…"; `unresolved` audit row |
| HOOK-PRE-03 | P1 | Bash cmd, near-miss `{{stm:openai}}` | block (exit 2) with did-you-mean; `malformed` audit row |
| HOOK-PRE-04 | P1 | Write tool, `content` contains `sk-ant-…` key shape | block (exit 2) "would write what looks like a real API key…" |
| HOOK-PRE-05 | P2 | Write tool, content contains only a placeholder | exit 0 (placeholders safe in files) |
| HOOK-PRE-06 | P1 | Bash cmd matching a **deny** policy rule | block (exit 2) "blocked by policy rule #id"; `policy.deny` audit |
| HOOK-PRE-07 | P2 | Bash cmd matching a **warn** rule | stderr warning, exit 0, command continues; `policy.warn` audit |
| HOOK-PRE-08 | P1 | Enforced project, out-of-scope placeholder | block (exit 2) "blocked by scope enforcement…"; synthetic `policy.deny` |
| HOOK-PRE-09 | P1 | Unparseable stdin | exit 0, no output (fail-safe) |
| HOOK-PRE-10 | P2 | Non-Bash / empty command | exit 0 no-op |
| HOOK-PRE-11 | P1 | Substitution audit | audit row stores **placeholder**, never the resolved value |

### I2. UserPromptSubmit
| ID | Pri | Input | Expected |
|----|----|----|----|
| HOOK-UPS-01 | P1 | prompt contains `sk-ant-…` shape | block (exit 2) "looks like it contains an API key…" |
| HOOK-UPS-02 | P1 | prompt contains an exact managed secret value (≥8 chars, no key shape) | block (exit 2) "contains a secret you manage with stm…" |
| HOOK-UPS-03 | P2 | benign prompt | exit 0 |
| HOOK-UPS-04 | P2 | empty prompt | exit 0 |

### I3. SessionStart
| ID | Pri | Input | Expected |
|----|----|----|----|
| HOOK-SS-01 | P1 | `{cwd:<non-project>}` | stdout JSON `additionalContext` = usage guidance; exit 0; never blocks |
| HOOK-SS-02 | P2 | `{cwd:<registered project>}` | additionalContext appends "PROJECT SCOPE" with that project's placeholders |
| HOOK-SS-03 | P2 | unparseable stdin | exit 0, still emits base guidance or no-ops safely |

### I4. PostToolUse
| ID | Pri | Input | Expected |
|----|----|----|----|
| HOOK-POST-01 | P1 | Bash output echoes a resolved managed key | alert (default mode block, exit 2) naming the leaked placeholder + "treat as COMPROMISED" |
| HOOK-POST-02 | P2 | Same, `STM_POSTTOOLUSE_MODE=warn` | stderr advisory + exit 0 (does not interrupt) |
| HOOK-POST-03 | P2 | Bash output with no secret | exit 0 |
| HOOK-POST-04 | P2 | Non-Bash tool | exit 0 |

## J. Security invariants (cross-cutting)  (Channel: bash)

| ID | Pri | Assertion | How to check |
|----|----|----|----|
| SEC-01 | P1 | Real key value never in the SQLite DB | After `add`, `strings /tmp/stm-qa.sqlite \| grep <secret>` → no match; only `keychain_ref` UUID present |
| SEC-02 | P1 | Real key value never in the audit log | `strings` DB / `audit` output after substitute → placeholders only |
| SEC-03 | P1 | Full card PAN rejected, not truncated | `--card-last4 4111111111111111` → error, and no 16-digit string anywhere in DB |
| SEC-04 | P1 | `resolve` refuses non-TTY | piped `resolve` → exit 1, no value on stdout |
| SEC-05 | P1 | Hooks fail safe | Every hook error path → exit 0 (Pre/UPS/SS) — never a leak; Post default → exit 2 alert |
| SEC-06 | P1 | Dashboard token never in stdout | `dashboard` stdout prints token-less URL; token only reaches browser (inspect `daemon.ts:571`) |
| SEC-07 | P1 | Placeholder grammar strict | `{{STM:...}}`, spaces, wrong arity → malformed/near-miss, not silent substitution |

---

## Findings protocol (for the testing agent)

Report each failure as a row: **`{id, title, severity(P1/P2/P3), area, repro (exact command/steps), observed, expected, evidence(stdout/screenshot path), file:line if known}`**. Do **not** report a failure you did not actually reproduce. Distinguish *product bug* from *test-harness/environment issue*. Group by area. If everything in an area passes, say so explicitly.
