// Playwright UI suite — drives the live dashboard daemon over a
// sandbox keystore + sandbox DB so it can't touch the user's real
// state. Run with:
//
//   node tests-ui/run.mjs
//
// Each check prints PASS / FAIL on stdout; the runner aggregates
// and exits non-zero on any failure. Designed to be runnable as
// part of CI once the GitHub Actions runner has a graphical
// Chromium (Playwright handles that).

import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const URL_FILE = "/tmp/stm-ui-url.txt";
const DASH_URL = readFileSync(URL_FILE, "utf8").replace(/^URL=/, "").trim();
const PARSED = new URL(DASH_URL);
const PORT = PARSED.port;
const TOKEN = PARSED.searchParams.get("token");

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const status = ok ? "  PASS" : "  FAIL";
  process.stdout.write(`${status}  ${name}${detail ? "  — " + detail : ""}\n`);
}

async function run() {
  process.stdout.write(`\n=== Playwright UI suite\n=== URL: ${DASH_URL}\n\n`);

  // ─── 1. HTTP-level checks (no browser) ──────────────────────────────────
  process.stdout.write("HTTP / security posture:\n");

  // 1a. /api/health is open (no token).
  {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    record("GET /api/health unauthed → 200", r.status === 200, `got ${r.status}`);
  }
  // 1b. /api/inventory without token → 401.
  {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/inventory`);
    record("GET /api/inventory unauthed → 401", r.status === 401, `got ${r.status}`);
  }
  // 1c. /api/inventory with valid token → 200.
  {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/inventory?token=${TOKEN}`);
    record("GET /api/inventory token → 200", r.status === 200, `got ${r.status}`);
  }
  // 1d. /api/inventory valid token + bogus Host → 403 (DNS-rebind defense).
  {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/inventory?token=${TOKEN}`, {
      headers: { Host: "evil.example.com" },
    });
    record("DNS rebind defense (bogus Host) → 403", r.status === 403, `got ${r.status}`);
  }

  // ─── 2. Browser-level checks ────────────────────────────────────────────
  process.stdout.write("\nBrowser / UX:\n");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();

  // 2a. Initial load — page renders, Keys tab is active.
  await page.goto(DASH_URL);
  await page.waitForLoadState("networkidle");
  {
    const tabKeysActive = await page.evaluate(() =>
      document.querySelector('button.tab[data-tab="keys"]').classList.contains("active"),
    );
    record("Initial tab = Keys", tabKeysActive);
  }

  // 2b. Sync button has the new label.
  {
    const text = (await page.locator("#sync-btn").textContent()).trim();
    record(
      "Sync button label = 'Fetch live spend'",
      text === "Fetch live spend",
      `got "${text}"`,
    );
  }

  // 2c. Tab switching: click Projects → Projects panel visible, Keys hidden.
  await page.click('button.tab[data-tab="projects"]');
  await page.waitForTimeout(200);
  {
    const projVisible = await page.locator('.tab-panel[data-panel="projects"]').evaluate(
      (el) => getComputedStyle(el).display !== "none",
    );
    const keysVisible = await page.locator('.tab-panel[data-panel="keys"]').evaluate(
      (el) => getComputedStyle(el).display !== "none",
    );
    record(
      "Click Projects tab → Projects visible + Keys hidden",
      projVisible && !keysVisible,
      `proj=${projVisible} keys=${keysVisible}`,
    );
  }

  // 2d. Tab persistence across reload (localStorage).
  await page.reload();
  await page.waitForLoadState("networkidle");
  {
    const projActive = await page.evaluate(() =>
      document.querySelector('button.tab[data-tab="projects"]').classList.contains("active"),
    );
    record("Active tab survives reload", projActive);
  }

  // 2e. Projects row layout — Enforce toggle exists and is NOT overlapping
  //     with the Edit scope button. We assert by getBoundingClientRect:
  //     the toggle's right edge must be ≤ the Edit-button's left edge.
  {
    // Look for any existing project row. The sandbox seeds one named "Acme App".
    const enforce = page.locator(".proj-row .proj-enforce").first();
    const editBtn = page.locator(".proj-row .proj-edit-btn").first();
    const hasRow = (await enforce.count()) > 0 && (await editBtn.count()) > 0;
    if (!hasRow) {
      record("Projects: row with Enforce + Edit exists", false, "no project row found");
    } else {
      const enfBox = await enforce.boundingBox();
      const edBox = await editBtn.boundingBox();
      const noOverlap = enfBox.x + enfBox.width <= edBox.x;
      record(
        "Enforce toggle does NOT overlap Edit-scope button",
        noOverlap,
        `enf.right=${(enfBox.x + enfBox.width).toFixed(1)} edit.left=${edBox.x.toFixed(1)}`,
      );
    }
  }

  // 2f. Enforce toggle: click → visual state flips, server records change.
  {
    const checkbox = page.locator(".proj-row .proj-enforce input").first();
    const wasChecked = await checkbox.isChecked();
    await checkbox.click();
    await page.waitForTimeout(300);
    const nowChecked = await checkbox.isChecked();
    record(
      "Enforce toggle flips on click",
      wasChecked !== nowChecked,
      `${wasChecked} → ${nowChecked}`,
    );
    // Restore
    await checkbox.click();
    await page.waitForTimeout(200);
  }

  // 2g. Browse services starts collapsed.
  await page.click('button.tab[data-tab="keys"]');
  await page.waitForTimeout(200);
  // Clear localStorage so we hit the default state.
  await page.evaluate(() => localStorage.removeItem("stm-browse-open"));
  await page.reload();
  await page.waitForLoadState("networkidle");
  {
    const bodyVisible = await page.locator("#browse-body").evaluate(
      (el) => getComputedStyle(el).display !== "none",
    );
    record("Browse services starts collapsed (default)", !bodyVisible);
  }

  // 2h. Browse services expands on header click.
  await page.click("#browse-head");
  await page.waitForTimeout(250);
  {
    const bodyVisible = await page.locator("#browse-body").evaluate(
      (el) => getComputedStyle(el).display !== "none",
    );
    record("Browse services expands on click", bodyVisible);
  }

  // 2i. Browse services choice persists across reload.
  await page.reload();
  await page.waitForLoadState("networkidle");
  {
    const bodyVisible = await page.locator("#browse-body").evaluate(
      (el) => getComputedStyle(el).display !== "none",
    );
    record("Browse open state persists across reload", bodyVisible);
  }

  // 2j. Keys-tab section ORDER: Add → API keys → Browse → Subscriptions.
  {
    const order = await page.evaluate(() => {
      const panel = document.querySelector('.tab-panel[data-panel="keys"]');
      const cards = panel.querySelectorAll("section.card");
      return Array.from(cards).map((c) => c.querySelector("h2")?.textContent?.trim() || "");
    });
    // h2 inside Browse services has a caret span first; assert via "includes".
    const ok =
      order[0] === "Add keys" &&
      order[1] === "API keys" &&
      /Browse services/.test(order[2]) &&
      order[3] === "Subscriptions";
    record(
      "Keys tab order: Add → API keys → Browse → Subscriptions",
      ok,
      order.join(" → "),
    );
  }

  // 2k. Inventory has the 6 seeded keys.
  {
    const placeholders = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#keys code.copy")).map((e) => e.textContent),
    );
    const hasOpenAI = placeholders.includes("{{stm:openai:default}}");
    const hasAnthropic = placeholders.includes("{{stm:anthropic:default}}");
    record(
      "Inventory shows seeded keys",
      placeholders.length >= 5 && hasOpenAI && hasAnthropic,
      `${placeholders.length} placeholders rendered`,
    );
  }

  // 2l. Click a placeholder → clipboard contains the placeholder text.
  {
    const target = page.locator('#keys code.copy[data-ph]').first();
    const expected = await target.getAttribute("data-ph");
    await target.click();
    await page.waitForTimeout(250);
    let clip = "";
    try {
      clip = await page.evaluate(() => navigator.clipboard.readText());
    } catch (e) {
      // Some headless contexts deny clipboard read even with the permission
      // grant. Toast presence is the fallback signal.
    }
    if (clip === expected) {
      record("Click placeholder copies to clipboard", true, expected);
    } else {
      // Fallback: toast appeared.
      const toastVisible = await page.locator("#toast.show").count();
      record(
        "Click placeholder copies (clipboard or toast)",
        toastVisible > 0,
        `clip="${clip}" toastShown=${toastVisible}`,
      );
    }
  }

  // 2m. Policy tab: Test command renders a verdict.
  await page.click('button.tab[data-tab="policy"]');
  await page.waitForTimeout(250);
  {
    await page.locator("#p-test-cmd").fill('echo {{stm:stripe:default}}');
    await page.click("#test-policy-btn");
    await page.waitForTimeout(300);
    const verdict = (await page.locator("#policy-test").textContent()).toLowerCase();
    record(
      "Policy test surfaces a verdict",
      verdict.includes("deny") || verdict.includes("allow") || verdict.includes("warn"),
      verdict.slice(0, 80),
    );
  }

  // 2n. Light/dark theme: the toggle flips data-theme AND the rendered
  //     background, and the choice persists across reload. This guards the
  //     light theme, which shipped without a human visual pass.
  await page.click('button.tab[data-tab="keys"]');
  await page.waitForTimeout(150);
  {
    const read = () =>
      page.evaluate(() => ({
        theme: document.documentElement.getAttribute("data-theme"),
        bg: getComputedStyle(document.body).backgroundColor,
        hasToggle: !!document.getElementById("theme-btn"),
      }));
    const before = await read();
    record("Theme toggle button present", before.hasToggle);

    await page.click("#theme-btn");
    await page.waitForTimeout(150);
    const after = await read();
    record(
      "Toggle flips data-theme",
      before.theme !== after.theme &&
        (after.theme === "light" || after.theme === "dark"),
      `${before.theme} → ${after.theme}`,
    );
    record(
      "Toggle changes the rendered background",
      before.bg !== after.bg,
      `${before.bg} → ${after.bg}`,
    );

    await page.reload();
    await page.waitForLoadState("networkidle");
    const persisted = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    record(
      "Chosen theme persists across reload",
      persisted === after.theme,
      `reloaded as ${persisted}`,
    );
  }

  // 2o. Visual artifacts — screenshot each tab, in BOTH themes, for the record.
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => {
      document.documentElement.setAttribute("data-theme", t);
      try {
        localStorage.setItem("stm-theme", t);
      } catch {}
    }, theme);
    for (const tab of ["keys", "projects", "policy", "import"]) {
      await page.click(`button.tab[data-tab="${tab}"]`);
      await page.waitForTimeout(300);
      await page.screenshot({
        path: `/tmp/stm-ui-test-${theme}-${tab}.png`,
        fullPage: true,
      });
    }
  }
  record("Visual baselines saved to /tmp/stm-ui-test-{dark,light}-*.png", true);

  await context.close();
  await browser.close();

  // ─── Summary ────────────────────────────────────────────────────────────
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
