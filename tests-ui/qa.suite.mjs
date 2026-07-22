// Extended QA Playwright suite — covers the DSH-* and API-* cases the
// original dashboard.suite.mjs does NOT already cover. Drives the sandbox
// daemon started by tests-ui/qa-run.mjs. Each check prints PASS/FAIL.
//
//   node tests-ui/qa-run.mjs
//
// A FAIL here should mean a real product bug — selectors/endpoints were
// checked against src/dashboard.ts + src/daemon.ts.

import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const URL_FILE = "/tmp/stm-ui-url.txt";
const DASH_URL = readFileSync(URL_FILE, "utf8").replace(/^URL=/, "").trim();
const PARSED = new URL(DASH_URL);
const ORIGIN = `${PARSED.protocol}//${PARSED.host}`;
const PORT = PARSED.port;
const TOKEN = PARSED.searchParams.get("token");
const HOME = process.env.HOME;
const IMPORT_DIR = "/tmp/stm-qa-import";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}\n`);
}
// Wrap a check body so a thrown error becomes a FAIL rather than aborting.
async function check(name, fn) {
  try {
    const [ok, detail] = await fn();
    record(name, ok, detail);
  } catch (e) {
    record(name, false, "threw: " + (e?.message ?? e));
  }
}

const api = (path, opts = {}) =>
  fetch(`${ORIGIN}${path}`, {
    ...opts,
    headers: { "X-STM-Token": TOKEN, "content-type": "application/json", ...(opts.headers || {}) },
  });

async function run() {
  process.stdout.write(`\n=== QA suite\n=== URL: ${DASH_URL}\n\n`);

  // ─────────────────────────────────────────────────────────────────────
  // G. HTTP / security posture (raw fetch)
  // ─────────────────────────────────────────────────────────────────────
  process.stdout.write("G. HTTP / security posture:\n");

  await check("API-05  GET / no token → 403", async () => {
    const r = await fetch(`${ORIGIN}/`);
    return [r.status === 403, `got ${r.status}`];
  });
  await check("API-06  GET /api/inventory?token=WRONG → 401", async () => {
    const r = await fetch(`${ORIGIN}/api/inventory?token=WRONG`);
    return [r.status === 401, `got ${r.status}`];
  });
  await check("API-07  security headers present", async () => {
    const r = await fetch(`${ORIGIN}/api/health`);
    const h = r.headers;
    const ok =
      h.get("x-content-type-options") === "nosniff" &&
      h.get("referrer-policy") === "no-referrer" &&
      h.get("cache-control") === "no-store";
    return [ok, `xcto=${h.get("x-content-type-options")} ref=${h.get("referrer-policy")} cc=${h.get("cache-control")}`];
  });
  await check("API-08  POST /api/keys missing tool/value → 400", async () => {
    const r = await api("/api/keys", { method: "POST", body: JSON.stringify({ tool: "x" }) });
    return [r.status === 400, `got ${r.status}`];
  });
  await check("API-09  DELETE /api/policies/999999 unknown → 404 'no such policy'", async () => {
    const r = await api("/api/policies/999999", { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    return [r.status === 404 && /no such policy/.test(j.error || ""), `got ${r.status} ${JSON.stringify(j)}`];
  });
  await check("API-10  POST /api/tools/subscription last4 not 4 digits → 400 (PAN guard)", async () => {
    const r = await api("/api/tools/subscription", {
      method: "POST",
      body: JSON.stringify({ tool: "github", cardLast4: "4111111111111111" }),
    });
    const j = await r.json().catch(() => ({}));
    return [r.status === 400 && /4 digits/.test(j.error || ""), `got ${r.status} ${JSON.stringify(j)}`];
  });
  await check("API-11  GET /api/audit?event=bogus → 400 'unknown event class'", async () => {
    const r = await api("/api/audit?event=bogus");
    const j = await r.json().catch(() => ({}));
    return [r.status === 400 && /unknown event class/.test(j.error || ""), `got ${r.status} ${JSON.stringify(j)}`];
  });
  await check("API-12  POST /api/spend/sync {provider:'bogus'} → 400 unknown provider", async () => {
    const r = await api("/api/spend/sync", { method: "POST", body: JSON.stringify({ provider: "bogus" }) });
    const j = await r.json().catch(() => ({}));
    return [r.status === 400 && /unknown provider/.test(j.error || ""), `got ${r.status} ${JSON.stringify(j)}`];
  });
  // DSH-K-27 (API-level read-merge): POST with only {tool,plan} preserves cost.
  await check("DSH-K-27  read-merge: omitted fields preserved (API)", async () => {
    // github seeded with cost=20. Send only a plan change.
    const r = await api("/api/tools/subscription", {
      method: "POST",
      body: JSON.stringify({ tool: "github", plan: "Enterprise" }),
    });
    if (!r.ok) return [false, `save status ${r.status}`];
    const inv = await (await api("/api/inventory")).json();
    const gh = inv.tools.find((t) => t.name === "github");
    return [gh && gh.plan === "Enterprise" && gh.monthly_cost === 20, `plan=${gh?.plan} cost=${gh?.monthly_cost}`];
  });

  // ─────────────────────────────────────────────────────────────────────
  // Browser setup — abort every non-loopback request so no real external
  // call ever leaves the machine, and record any that were attempted.
  // ─────────────────────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const external = [];
  await context.route("**/*", (route) => {
    let host = "";
    try { host = new URL(route.request().url()).hostname; } catch {}
    if (host === "127.0.0.1" || host === "localhost" || host === "") return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  // Record API calls the page fires, so we can assert a click hit an endpoint.
  const apiCalls = [];
  context.on("request", (req) => {
    const u = req.url();
    if (u.includes("/api/")) apiCalls.push({ method: req.method(), url: u });
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });

  const goto = async (url = DASH_URL) => {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
  };
  const clicksSince = (frag, method) => (i) =>
    apiCalls.slice(i).filter((c) => c.url.includes(frag) && (!method || c.method === method));

  await goto();

  // ─────────────────────────────────────────────────────────────────────
  // A. Header & global mechanics
  // ─────────────────────────────────────────────────────────────────────
  process.stdout.write("\nA. Header & global mechanics:\n");

  await check("DSH-H-01  no console errors on load", async () =>
    [pageErrors.length === 0, pageErrors.join(" | ").slice(0, 120)]);

  await check("DSH-H-03  keystore-label shows backend + title", async () => {
    const l = page.locator("#keystore-label");
    const text = (await l.textContent()).trim();
    const title = await l.getAttribute("title");
    return [text.length > 0 && /^Keys live in: /.test(title || ""), `text="${text}" title="${title}"`];
  });
  await check("DSH-H-04  agents-label shows 'agents: …' + tooltip", async () => {
    const l = page.locator("#agents-label");
    const text = (await l.textContent()).trim();
    const title = await l.getAttribute("title");
    return [/^agents: /.test(text) && (title || "").length > 0, `text="${text}"`];
  });
  await check("DSH-H-05  #spend renders $0.00 toFixed(2) format", async () => {
    const text = (await page.locator("#spend").textContent()).trim();
    return [/^\$\d+\.\d{2}$/.test(text), text];
  });
  await check("DSH-H-06  spend-source pill 'self-reported' (manual>0, fetched=0)", async () => {
    // github seeded with a manual cost, no fetched spend → self-reported.
    const text = (await page.locator("#spend-source").textContent()).trim();
    const cls = await page.locator("#spend-source").getAttribute("class");
    return [text === "self-reported" && /\bself\b/.test(cls || ""), `text="${text}" class="${cls}"`];
  });
  await check("DSH-H-08  sync click: disables→Syncing, log opens, POST {}, [skip] lines, restores", async () => {
    const before = apiCalls.length;
    const label0 = (await page.locator("#sync-btn").textContent()).trim();
    await page.click("#sync-btn");
    // Disabled + relabelled during the in-flight sync.
    const midDisabled = await page.locator("#sync-btn").isDisabled().catch(() => false);
    // Wait for the sync to complete: button re-enabled and label restored.
    await page.waitForFunction(
      (l) => { const b = document.getElementById("sync-btn"); return b && !b.disabled && b.textContent.trim() === l; },
      label0,
      { timeout: 15000 },
    );
    const posted = clicksSince("/api/spend/sync", "POST")(before).length > 0;
    const logVisible = await page.locator("#sync-log").evaluate((e) => getComputedStyle(e).display !== "none");
    const logText = await page.locator("#sync-log").textContent();
    // Sandbox seeds openai:admin-key (bogus) → [fail]; anthropic has no
    // admin-key → [skip]. Either way the log gets a per-provider result line.
    const hasProviderLine = /\[skip\]/.test(logText) || /\[fail\]/.test(logText) || /\[ok\]/.test(logText);
    const labelNow = (await page.locator("#sync-btn").textContent()).trim();
    const enabled = !(await page.locator("#sync-btn").isDisabled());
    return [posted && midDisabled && logVisible && hasProviderLine && labelNow === label0 && enabled,
      `posted=${posted} midDisabled=${midDisabled} log=${logVisible} providerLine=${hasProviderLine} label="${labelNow}" enabled=${enabled}`];
  });
  await check("DSH-H-10  toast auto-hides (~1.9s)", async () => {
    // trigger a copy toast
    await page.locator('#keys code.copy[data-ph]').first().click();
    await page.waitForTimeout(150);
    const shown = await page.locator("#toast").evaluate((e) => e.classList.contains("show"));
    await page.waitForTimeout(2100);
    const hidden = await page.locator("#toast").evaluate((e) => !e.classList.contains("show"));
    return [shown && hidden, `shown=${shown} hiddenAfter=${hidden}`];
  });

  // ─────────────────────────────────────────────────────────────────────
  // B. Keys tab
  // ─────────────────────────────────────────────────────────────────────
  process.stdout.write("\nB. Keys tab:\n");
  await page.click('button.tab[data-tab="keys"]');
  await page.waitForTimeout(100);

  await check("DSH-K-02  #svc has 50 catalog + trailing 'Other (custom)'", async () => {
    const opts = await page.$$eval("#svc option", (os) => os.map((o) => ({ v: o.value, t: o.textContent })));
    const last = opts[opts.length - 1];
    const catalogCount = opts.length - 1;
    return [last.v === "other" && /Other/.test(last.t) && catalogCount === 50,
      `total=${opts.length} catalog=${catalogCount} last="${last.t}"`];
  });
  await check("DSH-K-03  catalog service → password input labelled 'name · label'", async () => {
    await page.selectOption("#svc", "0");
    await page.waitForTimeout(100);
    const inputs = await page.$$eval("#svc-fields input[type=password]", (is) => is.length);
    const labelTxt = await page.$eval("#svc-fields label", (l) => l.textContent.trim());
    return [inputs >= 1 && labelTxt.includes("·"), `pwInputs=${inputs} label="${labelTxt}"`];
  });
  await check("DSH-K-04  'Other (custom)' → #o-tool, #o-label(default), #o-value", async () => {
    await page.selectOption("#svc", "other");
    await page.waitForTimeout(100);
    const hasTool = await page.locator("#o-tool").count();
    const lblVal = await page.locator("#o-label").inputValue();
    const hasValue = await page.locator("#o-value").count();
    return [hasTool === 1 && hasValue === 1 && lblVal === "default", `label="${lblVal}"`];
  });
  await check("DSH-K-05  '+ Add another field' appends .cf-row; ✕ removes it", async () => {
    await page.selectOption("#svc", "0");
    await page.waitForTimeout(80);
    await page.click("#add-field-btn");
    const after1 = await page.locator("#custom-fields .cf-row").count();
    await page.click("#custom-fields .cf-row .cf-del");
    await page.waitForTimeout(50);
    const after2 = await page.locator("#custom-fields .cf-row").count();
    return [after1 === 1 && after2 === 0, `add→${after1} del→${after2}`];
  });
  await check("DSH-K-07  Other, value blank → client blocks, no POST", async () => {
    await page.selectOption("#svc", "other");
    await page.waitForTimeout(80);
    await page.fill("#o-tool", "qa-blank-tool");
    const before = apiCalls.length;
    await page.click("#add-btn");
    await page.waitForTimeout(200);
    const posted = clicksSince("/api/keys", "POST")(before).length > 0;
    const msg = (await page.locator("#add-msg").textContent()).trim();
    return [!posted && /Tool and secret value are required/.test(msg), `posted=${posted} msg="${msg}"`];
  });
  await check("DSH-K-08  catalog, all fields blank → 'Fill at least one field.'", async () => {
    await page.selectOption("#svc", "0");
    await page.waitForTimeout(80);
    const before = apiCalls.length;
    await page.click("#add-btn");
    await page.waitForTimeout(200);
    const posted = clicksSince("/api/keys", "POST")(before).length > 0;
    const msg = (await page.locator("#add-msg").textContent()).trim();
    return [!posted && /Fill at least one field/.test(msg), `posted=${posted} msg="${msg}"`];
  });
  await check("DSH-K-06  Other + tool+value → POST /api/keys, success, inventory grows, inputs cleared", async () => {
    await page.selectOption("#svc", "other");
    await page.waitForTimeout(80);
    const invBefore = (await (await api("/api/inventory")).json()).keys.length;
    await page.fill("#o-tool", "qa-newtool");
    await page.fill("#o-value", "qa-secret-value-123");
    const before = apiCalls.length;
    await page.click("#add-btn");
    await page.waitForTimeout(400);
    const posted = clicksSince("/api/keys", "POST")(before).length > 0;
    const msg = (await page.locator("#add-msg").textContent()).trim();
    const invAfter = (await (await api("/api/inventory")).json()).keys.length;
    // form re-render on "other" keeps o-value cleared (re-render clears inputs)
    const rendered = await page.evaluate(() => {
      const inv = document.querySelectorAll("#keys code.copy");
      return Array.from(inv).some((c) => c.textContent.includes("qa-newtool"));
    });
    return [posted && /Added/.test(msg) && invAfter === invBefore + 1 && rendered,
      `posted=${posted} msg="${msg.slice(0, 40)}" inv ${invBefore}→${invAfter} rendered=${rendered}`];
  });
  await check("DSH-K-09  duplicate label → per-item failure '…already exists…'", async () => {
    // add openai:default again via the Other path (tool=openai,label=default)
    await page.selectOption("#svc", "other");
    await page.waitForTimeout(80);
    await page.fill("#o-tool", "openai");
    await page.fill("#o-label", "default");
    await page.fill("#o-value", "dupe-value");
    await page.click("#add-btn");
    await page.waitForTimeout(400);
    const msg = (await page.locator("#add-msg").textContent()).trim();
    return [/already exists/.test(msg) && /failed/.test(msg), `msg="${msg}"`];
  });
  await check("DSH-K-14  Revoke → POST /api/keys/revoke, row flips revoked, button gone", async () => {
    // revoke qa-newtool:default (added above, active)
    const before = apiCalls.length;
    const row = page.locator('#keys tr', { has: page.locator('code:has-text("qa-newtool")') }).first();
    const revBtn = row.locator("button.rev");
    if (!(await revBtn.count())) return [false, "no Revoke button on qa-newtool row"];
    await revBtn.click();
    await page.waitForTimeout(400);
    const posted = clicksSince("/api/keys/revoke", "POST")(before).length > 0;
    const rowAfter = page.locator('#keys tr', { has: page.locator('code:has-text("qa-newtool")') }).first();
    const badge = (await rowAfter.locator(".badge").textContent()).trim();
    const stillHasBtn = await rowAfter.locator("button.rev").count();
    return [posted && badge === "revoked" && stillHasBtn === 0, `posted=${posted} badge="${badge}" btn=${stillHasBtn}`];
  });
  await check("DSH-K-21  browse tile → window.open(url,noopener), sets #svc, renders fields, flashes card", async () => {
    // expand browse
    await page.evaluate(() => localStorage.setItem("stm-browse-open", "1"));
    await goto();
    await page.click('button.tab[data-tab="keys"]');
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.__opens = [];
      const orig = window.open;
      window.open = function (u, t, f) { window.__opens.push({ u, t, f }); return null; };
    });
    const tile = page.locator("#svc-categories .svc-tile").first();
    const idx = await tile.getAttribute("data-idx");
    await tile.click();
    await page.waitForTimeout(300);
    const opens = await page.evaluate(() => window.__opens);
    const svcVal = await page.locator("#svc").inputValue();
    const flashed = await page.locator("#add-keys-card").evaluate((e) => e.classList.contains("flash"));
    const fieldsRendered = await page.locator("#svc-fields input").count();
    const ok = opens.length === 1 && /^https?:\/\//.test(opens[0].u) &&
      /noopener/.test(opens[0].f || "") && svcVal === idx && fieldsRendered >= 1 && flashed;
    return [ok, `opens=${JSON.stringify(opens[0])} svc=${svcVal}/${idx} fields=${fieldsRendered} flash=${flashed}`];
  });

  // Subscriptions editing (use a fresh load to reset editing state)
  await goto();
  await page.click('button.tab[data-tab="keys"]');
  await page.waitForTimeout(150);

  await check("DSH-K-23  Edit → inline form (plan/cost/nick/last4/renews/Save/Cancel)", async () => {
    const row = page.locator('#tools tr', { has: page.locator('button.sub-edit[data-tool="github"]') });
    await row.locator("button.sub-edit").click();
    await page.waitForTimeout(150);
    const edRow = page.locator('#tools tr[data-tool="github"]');
    const fields = {
      plan: await edRow.locator(".ed-plan").count(),
      cost: await edRow.locator(".ed-cost").count(),
      nick: await edRow.locator(".ed-card-nick").count(),
      last4: await edRow.locator(".ed-card-last4").count(),
      renews: await edRow.locator(".ed-renews").count(),
      save: await edRow.locator(".sub-save").count(),
      cancel: await edRow.locator(".sub-cancel").count(),
    };
    // last4 must NOT carry maxlength — a pasted PAN is normalized to its last
    // four by JS, not pre-truncated to its first four by the browser.
    const maxlen = await edRow.locator(".ed-card-last4").getAttribute("maxlength");
    const ok = Object.values(fields).every((n) => n === 1) && maxlen === null;
    return [ok, `${JSON.stringify(fields)} maxlen=${maxlen}`];
  });
  await check("DSH-K-24  set last4=1234 + nick, Save → POST, toast, Card cell 'Nick ••1234'", async () => {
    // still in edit mode from DSH-K-23
    const edRow = page.locator('#tools tr[data-tool="github"]');
    await edRow.locator(".ed-card-last4").fill("1234");
    await edRow.locator(".ed-card-nick").fill("Personal Amex");
    const before = apiCalls.length;
    await edRow.locator(".sub-save").click();
    await page.waitForTimeout(500);
    const posted = clicksSince("/api/tools/subscription", "POST")(before).length > 0;
    const cardCell = await page.locator('#tools tr', { has: page.locator('button.sub-edit[data-tool="github"]') })
      .locator("td").nth(3).textContent();
    return [posted && /Personal Amex/.test(cardCell) && /1234/.test(cardCell),
      `posted=${posted} card="${cardCell.trim()}"`];
  });
  await check("DSH-K-25a  last4 normalizer: pasted 16-digit PAN → LAST four (1111, not 4111)", async () => {
    // Corrected behavior: no maxlength cap; the input handler strips non-digits
    // and keeps the last four, so a pasted full PAN yields its true last four.
    const row = page.locator('#tools tr', { has: page.locator('button.sub-edit[data-tool="github"]') });
    await row.locator("button.sub-edit").click();
    await page.waitForTimeout(120);
    const inp = page.locator('#tools tr[data-tool="github"] .ed-card-last4');
    await inp.fill("4111111111111111");
    const typed = await inp.inputValue();
    return [typed === "1111", `field normalized to "${typed}" (expected last-4 "1111", not first-4 "4111")`];
  });
  await check("DSH-K-25b  paste full PAN → Save persists LAST four, card shows ••1111 (not ••4111)", async () => {
    // Still in edit mode from DSH-K-25a. Saving must round-trip the normalized
    // last four (1111), never the card's first four (4111).
    const inp = page.locator('#tools tr[data-tool="github"] .ed-card-last4');
    const normalized = await inp.inputValue();
    const before = apiCalls.length;
    await page.locator('#tools tr[data-tool="github"] .sub-save').click();
    await page.waitForTimeout(500);
    const posted = clicksSince("/api/tools/subscription", "POST")(before).length > 0;
    const cardCell = await page.locator('#tools tr', { has: page.locator('button.sub-edit[data-tool="github"]') })
      .locator("td").nth(3).textContent();
    const inv = await (await api("/api/inventory")).json();
    const gh = inv.tools.find((t) => t.name === "github");
    const ok = posted && normalized === "1111" && gh.card_last4 === "1111" &&
      /1111/.test(cardCell) && !/4111/.test(cardCell);
    return [ok, `posted=${posted} normalized=${normalized} stored=${gh.card_last4} card="${cardCell.trim()}"`];
  });
  await check("DSH-K-25c  normal 4-digit entry (4321) round-trips to ••4321", async () => {
    const row = page.locator('#tools tr', { has: page.locator('button.sub-edit[data-tool="github"]') });
    await row.locator("button.sub-edit").click();
    await page.waitForTimeout(120);
    const inp = page.locator('#tools tr[data-tool="github"] .ed-card-last4');
    await inp.fill("4321");
    const typed = await inp.inputValue();
    const before = apiCalls.length;
    await page.locator('#tools tr[data-tool="github"] .sub-save').click();
    await page.waitForTimeout(500);
    const posted = clicksSince("/api/tools/subscription", "POST")(before).length > 0;
    const cardCell = await page.locator('#tools tr', { has: page.locator('button.sub-edit[data-tool="github"]') })
      .locator("td").nth(3).textContent();
    const inv = await (await api("/api/inventory")).json();
    const gh = inv.tools.find((t) => t.name === "github");
    return [posted && typed === "4321" && gh.card_last4 === "4321" && /4321/.test(cardCell),
      `posted=${posted} typed=${typed} stored=${gh.card_last4} card="${cardCell.trim()}"`];
  });
  await check("DSH-K-26  Edit → Cancel reverts, no write", async () => {
    const row = page.locator('#tools tr', { has: page.locator('button.sub-edit[data-tool="github"]') });
    await row.locator("button.sub-edit").click();
    await page.waitForTimeout(120);
    const before = apiCalls.length;
    await page.locator('#tools tr[data-tool="github"] .sub-cancel').click();
    await page.waitForTimeout(200);
    const posted = clicksSince("/api/tools/subscription", "POST")(before).length > 0;
    const backToDisplay = await page.locator('#tools tr', { has: page.locator('button.sub-edit[data-tool="github"]') }).count();
    return [!posted && backToDisplay === 1, `posted=${posted} display=${backToDisplay}`];
  });
  await check("DSH-K-27b  explicit-blank clears card (UI)", async () => {
    const row = page.locator('#tools tr', { has: page.locator('button.sub-edit[data-tool="github"]') });
    await row.locator("button.sub-edit").click();
    await page.waitForTimeout(120);
    const edRow = page.locator('#tools tr[data-tool="github"]');
    await edRow.locator(".ed-card-last4").fill("");
    await edRow.locator(".ed-card-nick").fill("");
    await edRow.locator(".sub-save").click();
    await page.waitForTimeout(500);
    const inv = await (await api("/api/inventory")).json();
    const gh = inv.tools.find((t) => t.name === "github");
    return [gh.card_last4 == null && gh.card_nickname == null, `last4=${gh.card_last4} nick=${gh.card_nickname}`];
  });

  // ─────────────────────────────────────────────────────────────────────
  // C. Projects tab
  // ─────────────────────────────────────────────────────────────────────
  process.stdout.write("\nC. Projects tab:\n");
  await goto();
  await page.click('button.tab[data-tab="projects"]');
  await page.waitForTimeout(200);

  await check("DSH-P-03  Enforce toggle → POST /enforce + toast", async () => {
    const before = apiCalls.length;
    const cb = page.locator(".proj-row .proj-enforce input").first();
    await cb.click();
    await page.waitForTimeout(400);
    const posted = clicksSince("/enforce", "POST")(before).length > 0;
    const toast = (await page.locator("#toast").textContent()).trim();
    // restore
    await page.locator(".proj-row .proj-enforce input").first().click();
    await page.waitForTimeout(300);
    return [posted && /Enforcement (ON|OFF)/.test(toast), `posted=${posted} toast="${toast}"`];
  });
  await check("DSH-P-04  Edit scope → checklist of active keys, button → 'Done'", async () => {
    await page.locator(".proj-row .proj-edit-btn").first().click();
    await page.waitForTimeout(200);
    const checklist = await page.locator(".proj-edit .checklist input.scope-toggle").count();
    const btnLabel = (await page.locator(".proj-row .proj-edit-btn").first().textContent()).trim();
    return [checklist >= 1 && btnLabel === "Done", `checklist=${checklist} btn="${btnLabel}"`];
  });
  await check("DSH-P-05  check unscoped key → POST /scope, pill appears", async () => {
    const before = apiCalls.length;
    const box = page.locator(".proj-edit .checklist input.scope-toggle").first();
    const tool = await box.getAttribute("data-tool");
    const label = await box.getAttribute("data-label");
    if (await box.isChecked()) await box.uncheck(); // ensure unchecked start
    await page.waitForTimeout(300);
    const before2 = apiCalls.length;
    await box.check();
    await page.waitForTimeout(400);
    const posted = clicksSince("/scope", "POST")(before2).length > 0;
    const pill = await page.locator(`.proj-pills code:has-text("${tool}:${label}")`).count();
    return [posted && pill >= 1, `posted=${posted} pill=${pill} (${tool}:${label})`];
  });
  await check("DSH-P-06  uncheck scoped key → DELETE /scope, pill removed", async () => {
    const box = page.locator(".proj-edit .checklist input.scope-toggle:checked").first();
    if (!(await box.count())) return [false, "no checked scope box to uncheck"];
    const tool = await box.getAttribute("data-tool");
    const label = await box.getAttribute("data-label");
    const before = apiCalls.length;
    await box.uncheck();
    await page.waitForTimeout(400);
    const posted = clicksSince("/scope", "DELETE")(before).length > 0;
    const pill = await page.locator(`.proj-pills code:has-text("${tool}:${label}")`).count();
    return [posted && pill === 0, `posted=${posted} pillRemaining=${pill}`];
  });
  await check("DSH-P-11  Add: one field blank → client blocks", async () => {
    const before = apiCalls.length;
    await page.fill("#proj-path", "/tmp/qa-x");
    await page.fill("#proj-name", "");
    await page.click("#proj-add-btn");
    await page.waitForTimeout(200);
    const posted = clicksSince("/api/projects", "POST")(before).length > 0;
    const msg = (await page.locator("#proj-msg").textContent()).trim();
    return [!posted && /both required/.test(msg), `posted=${posted} msg="${msg}"`];
  });
  await check("DSH-P-10  Add path+name → POST, 'Project added.', inputs cleared, row appears", async () => {
    const before = apiCalls.length;
    await page.fill("#proj-path", "/tmp/qa-proj-added");
    await page.fill("#proj-name", "QA Added");
    await page.click("#proj-add-btn");
    await page.waitForTimeout(400);
    const posted = clicksSince("/api/projects", "POST")(before).length > 0;
    const msg = (await page.locator("#proj-msg").textContent()).trim();
    const cleared = (await page.locator("#proj-path").inputValue()) === "";
    const row = await page.locator('.proj-row .name:has-text("QA Added")').count();
    return [posted && /Project added/.test(msg) && cleared && row >= 1,
      `posted=${posted} msg="${msg}" cleared=${cleared} row=${row}`];
  });
  await check("DSH-P-12  Name field Enter → submits", async () => {
    const before = apiCalls.length;
    await page.fill("#proj-path", "/tmp/qa-proj-enter");
    await page.fill("#proj-name", "QA Enter");
    await page.locator("#proj-name").press("Enter");
    await page.waitForTimeout(400);
    const posted = clicksSince("/api/projects", "POST")(before).length > 0;
    const row = await page.locator('.proj-row .name:has-text("QA Enter")').count();
    return [posted && row >= 1, `posted=${posted} row=${row}`];
  });
  await check("DSH-P-09  Remove → dismiss confirm → no deletion", async () => {
    page.once("dialog", (d) => d.dismiss());
    const before = apiCalls.length;
    const row = page.locator('.proj-row', { has: page.locator('.name:has-text("QA Enter")') });
    await row.locator(".proj-remove-btn").click();
    await page.waitForTimeout(300);
    const deleted = clicksSince("/api/projects/", "DELETE")(before).length > 0;
    const stillThere = await page.locator('.proj-row .name:has-text("QA Enter")').count();
    return [!deleted && stillThere >= 1, `deleted=${deleted} stillThere=${stillThere}`];
  });
  await check("DSH-P-08  Remove → confirm → DELETE, toast, row gone", async () => {
    page.once("dialog", (d) => d.accept());
    const before = apiCalls.length;
    const row = page.locator('.proj-row', { has: page.locator('.name:has-text("QA Enter")') });
    await row.locator(".proj-remove-btn").click();
    await page.waitForTimeout(400);
    const deleted = clicksSince("/api/projects/", "DELETE")(before).length > 0;
    const toast = (await page.locator("#toast").textContent()).trim();
    const gone = (await page.locator('.proj-row .name:has-text("QA Enter")').count()) === 0;
    return [deleted && /Project removed/.test(toast) && gone, `deleted=${deleted} toast="${toast}" gone=${gone}`];
  });
  await check("DSH-P-14  ?from=<matching cwd> → 'Session in <name>' + Edit-scope pill", async () => {
    const cwd = `${HOME}/code/acme-app`;
    await goto(`${DASH_URL}&from=${encodeURIComponent(cwd)}`);
    await page.waitForTimeout(300);
    const box = page.locator("#session-signal");
    const visible = await box.evaluate((e) => getComputedStyle(e).display !== "none");
    const text = (await box.textContent()).trim();
    const hasEditBtn = await box.locator("#signal-edit-btn").count();
    return [visible && /Session in/.test(text) && /Acme App/.test(text) && hasEditBtn === 1,
      `visible=${visible} text="${text.slice(0, 60)}"`];
  });
  await check("DSH-P-15  ?from=<unmatched cwd> → 'no project matches' + Create button", async () => {
    const cwd = "/tmp/stm-qa-nomatch-xyz";
    await goto(`${DASH_URL}&from=${encodeURIComponent(cwd)}`);
    await page.waitForTimeout(300);
    const box = page.locator("#session-signal");
    const visible = await box.evaluate((e) => getComputedStyle(e).display !== "none");
    const text = (await box.textContent()).trim();
    const createBtn = await box.locator("#signal-create-btn").count();
    return [visible && /no project matches/.test(text) && createBtn === 1, `visible=${visible} text="${text.slice(0, 60)}"`];
  });

  // ─────────────────────────────────────────────────────────────────────
  // D. Policy & audit tab
  // ─────────────────────────────────────────────────────────────────────
  process.stdout.write("\nD. Policy & audit tab:\n");
  await goto();
  await page.click('button.tab[data-tab="policy"]');
  await page.waitForTimeout(200);

  let addedRuleId = null;
  await check("DSH-D-02  Add rule (deny + key glob) → POST, 'Added rule #id', row, form resets", async () => {
    const before = apiCalls.length;
    await page.fill("#p-key", "qa-test:*");
    await page.selectOption("#p-action", "deny");
    await page.fill("#p-order", "150");
    await page.fill("#p-reason", "qa reason");
    await page.click("#add-policy-btn");
    await page.waitForTimeout(400);
    const posted = clicksSince("/api/policies", "POST")(before).length > 0;
    const msg = (await page.locator("#policy-msg").textContent()).trim();
    const m = msg.match(/Added rule #(\d+)/);
    if (m) addedRuleId = m[1];
    const orderReset = (await page.locator("#p-order").inputValue()) === "100";
    const actionReset = (await page.locator("#p-action").inputValue()) === "deny";
    const keyReset = (await page.locator("#p-key").inputValue()) === "";
    const row = await page.locator('#policies code:has-text("qa-test:*")').count();
    return [posted && !!m && orderReset && actionReset && keyReset && row >= 1,
      `posted=${posted} msg="${msg}" orderReset=${orderReset} row=${row}`];
  });
  await check("DSH-D-03  Remove rule → confirm → DELETE, toast, row gone", async () => {
    if (!addedRuleId) return [false, "no rule id from DSH-D-02"];
    page.once("dialog", (d) => d.accept());
    const before = apiCalls.length;
    const row = page.locator('#policies tr', { has: page.locator('code:has-text("qa-test:*")') });
    await row.locator(".pol-del").click();
    await page.waitForTimeout(400);
    const deleted = clicksSince("/api/policies/", "DELETE")(before).length > 0;
    const toast = (await page.locator("#toast").textContent()).trim();
    const gone = (await page.locator('#policies code:has-text("qa-test:*")').count()) === 0;
    return [deleted && new RegExp(`Rule #${addedRuleId} removed`).test(toast) && gone,
      `deleted=${deleted} toast="${toast}" gone=${gone}`];
  });
  await check("DSH-D-11  change event filter → refetch /api/audit?event=…", async () => {
    const before = apiCalls.length;
    await page.selectOption("#audit-event", "substitute");
    await page.waitForTimeout(400);
    const got = apiCalls.slice(before).find((c) => c.url.includes("/api/audit") && c.url.includes("event=substitute"));
    return [!!got, got ? got.url.split("?")[1] : "no matching request"];
  });
  await check("DSH-D-12  type tool filter + Enter → refetch with tool=", async () => {
    await page.selectOption("#audit-event", "");
    await page.waitForTimeout(200);
    const before = apiCalls.length;
    await page.fill("#audit-tool", "openai");
    await page.locator("#audit-tool").press("Enter");
    await page.waitForTimeout(400);
    const got = apiCalls.slice(before).find((c) => c.url.includes("/api/audit") && c.url.includes("tool=openai"));
    return [!!got, got ? got.url.split("?")[1] : "no matching request"];
  });
  await check("DSH-D-13  Refresh → re-fetch /api/audit", async () => {
    await page.fill("#audit-tool", "");
    const before = apiCalls.length;
    await page.click("#audit-refresh-btn");
    await page.waitForTimeout(400);
    const got = apiCalls.slice(before).find((c) => c.url.includes("/api/audit"));
    return [!!got, got ? "refetched" : "no request"];
  });
  await check("DSH-D-14  Clear log → confirm → POST /api/audit/clear, toast 'Cleared N', table empties", async () => {
    page.once("dialog", (d) => d.accept());
    const before = apiCalls.length;
    await page.click("#audit-clear-btn");
    await page.waitForTimeout(500);
    const posted = clicksSince("/api/audit/clear", "POST")(before).length > 0;
    const toast = (await page.locator("#toast").textContent()).trim();
    const emptied = await page.locator("#audit-rows .empty").count();
    return [posted && /Cleared \d+ row/.test(toast) && emptied >= 1, `posted=${posted} toast="${toast}" emptied=${emptied}`];
  });

  // ─────────────────────────────────────────────────────────────────────
  // E. Import tab
  // ─────────────────────────────────────────────────────────────────────
  process.stdout.write("\nE. Import tab:\n");
  await goto();
  await page.click('button.tab[data-tab="import"]');
  await page.waitForTimeout(200);

  await check("DSH-I-03  blank dir → 'Enter a directory to scan.'", async () => {
    const before = apiCalls.length;
    await page.fill("#imp-dir", "");
    await page.click("#scan-btn");
    await page.waitForTimeout(300);
    const posted = clicksSince("/api/import/scan", "POST")(before).length > 0;
    const msg = (await page.locator("#imp-msg").textContent()).trim();
    return [!posted && /Enter a directory to scan/.test(msg), `posted=${posted} msg="${msg}"`];
  });
  await check("DSH-I-01  dir with .env → POST scan, 'Found N', table (masked value, Import checked)", async () => {
    const before = apiCalls.length;
    await page.fill("#imp-dir", IMPORT_DIR);
    await page.click("#scan-btn");
    await page.waitForTimeout(500);
    const posted = clicksSince("/api/import/scan", "POST")(before).length > 0;
    const msg = (await page.locator("#imp-msg").textContent()).trim();
    const tableVisible = await page.locator("#imp-table").evaluate((e) => getComputedStyle(e).display !== "none");
    const rows = await page.locator("#imp-rows tr").count();
    const checked = await page.locator("#imp-rows input[type=checkbox]").first().isChecked();
    const valCell = (await page.locator("#imp-rows tr").first().locator("td").nth(1).textContent()).trim();
    const masked = !valCell.includes("abcdef123456"); // raw not shown
    return [posted && /Found \d+ candidate/.test(msg) && tableVisible && rows >= 1 && checked && masked,
      `posted=${posted} msg="${msg}" rows=${rows} checked=${checked} val="${valCell}"`];
  });
  await check("DSH-I-06  masking: scan response carries valueMasked, never raw secret", async () => {
    const r = await api("/api/import/scan", { method: "POST", body: JSON.stringify({ dirs: [IMPORT_DIR] }) });
    const j = await r.json();
    const c = (j.candidates || [])[0] || {};
    const hasMasked = typeof c.valueMasked === "string";
    const body = JSON.stringify(j);
    const leaked = body.includes("sk-qa-mistral-abcdef123456");
    return [hasMasked && !leaked, `masked="${c.valueMasked}" leaked=${leaked}`];
  });
  await check("DSH-I-05  none checked → 'Nothing selected.'", async () => {
    // uncheck the row then import
    const cb = page.locator("#imp-rows input[type=checkbox]").first();
    if (await cb.isChecked()) await cb.uncheck();
    const before = apiCalls.length;
    await page.click("#imp-btn");
    await page.waitForTimeout(300);
    const posted = clicksSince("/api/import/confirm", "POST")(before).length > 0;
    const msg = (await page.locator("#imp-msg").textContent()).trim();
    return [!posted && /Nothing selected/.test(msg), `posted=${posted} msg="${msg}"`];
  });
  await check("DSH-I-04  import selected → POST confirm, 'Imported N', key in inventory", async () => {
    const cb = page.locator("#imp-rows input[type=checkbox]").first();
    if (!(await cb.isChecked())) await cb.check();
    const invBefore = (await (await api("/api/inventory")).json()).keys.length;
    const before = apiCalls.length;
    await page.click("#imp-btn");
    await page.waitForTimeout(600);
    const posted = clicksSince("/api/import/confirm", "POST")(before).length > 0;
    const msg = (await page.locator("#imp-msg").textContent()).trim();
    const invAfter = (await (await api("/api/inventory")).json()).keys.length;
    return [posted && /Imported \d+ key/.test(msg) && invAfter === invBefore + 1,
      `posted=${posted} msg="${msg}" inv ${invBefore}→${invAfter}`];
  });

  // ─────────────────────────────────────────────────────────────────────
  // F. Theme & navigation
  // ─────────────────────────────────────────────────────────────────────
  process.stdout.write("\nF. Theme & navigation:\n");
  await goto();
  await page.waitForTimeout(150);

  await check("DSH-T-05  each tab: correct panel shows, others hidden, aria-selected set", async () => {
    const tabs = ["keys", "projects", "policy", "import"];
    let allOk = true, detail = [];
    for (const t of tabs) {
      await page.click(`button.tab[data-tab="${t}"]`);
      await page.waitForTimeout(120);
      const state = await page.evaluate((name) => {
        const panels = Array.from(document.querySelectorAll(".tab-panel"));
        const shown = panels.filter((p) => getComputedStyle(p).display !== "none").map((p) => p.getAttribute("data-panel"));
        const tab = document.querySelector('button.tab[data-tab="' + name + '"]');
        return { shown, aria: tab.getAttribute("aria-selected") };
      }, t);
      const ok = state.shown.length === 1 && state.shown[0] === t && state.aria === "true";
      if (!ok) { allOk = false; detail.push(`${t}:${JSON.stringify(state)}`); }
    }
    return [allOk, detail.join(" ") || "all tabs ok"];
  });

  // DSH-T-04 — light theme readability. Force light, screenshot each tab, and
  // programmatically scan for dark-text-on-dark-bg (both luminances low).
  await check("DSH-T-04  light theme: no dark-on-dark surfaces across tabs", async () => {
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "light");
      try { localStorage.setItem("stm-theme", "light"); } catch {}
    });
    const offenders = [];
    for (const tab of ["keys", "projects", "policy", "import"]) {
      await page.click(`button.tab[data-tab="${tab}"]`);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `/tmp/stm-qa-light-${tab}.png`, fullPage: true });
      const bad = await page.evaluate((tabName) => {
        function lum(c) {
          const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null;
          const [r, g, b, a] = m[1].split(",").map((x) => parseFloat(x));
          if (a !== undefined && a === 0) return null; // transparent — inherits
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
        const out = [];
        const els = document.querySelectorAll(
          '.tab-panel.active *'
        );
        for (const el of els) {
          if (!el.textContent || !el.textContent.trim()) continue;
          if (el.children.length > 0) continue; // leaf text nodes only
          const cs = getComputedStyle(el);
          const fg = lum(cs.color);
          // walk up for an opaque background
          let bg = null, node = el;
          while (node && bg === null) { bg = lum(getComputedStyle(node).backgroundColor); node = node.parentElement; }
          if (fg === null || bg === null) continue;
          // dark-on-dark: both dark AND low contrast
          if (fg < 90 && bg < 90 && Math.abs(fg - bg) < 45) {
            out.push(tabName + ":" + (el.className || el.tagName) + " fg=" + fg.toFixed(0) + " bg=" + bg.toFixed(0) + " '" + el.textContent.trim().slice(0, 20) + "'");
          }
        }
        return out;
      }, tab);
      offenders.push(...bad);
    }
    return [offenders.length === 0, offenders.slice(0, 6).join(" | ") || "screenshots: /tmp/stm-qa-light-*.png"];
  });

  // ─────────────────────────────────────────────────────────────────────
  // DSH-H-11 — no outbound external network fired during the whole run
  // (all non-loopback requests were aborted AND recorded).
  // ─────────────────────────────────────────────────────────────────────
  process.stdout.write("\nA (cont). Network posture:\n");
  await check("DSH-H-11  no external (non-loopback) network calls fired by the page", async () =>
    [external.length === 0, external.length ? external.slice(0, 5).join(" | ") : "none"]);

  await context.close();
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n=== ${results.length - failed.length} / ${results.length} passed\n`);
  if (failed.length > 0) {
    process.stdout.write("Failures:\n");
    for (const f of failed) process.stdout.write(`  - ${f.name}: ${f.detail || ""}\n`);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((e) => {
  console.error("SUITE ERROR:", e?.stack ?? e);
  process.exit(2);
});
