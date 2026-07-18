import { test, expect, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, assertCardLast4 } from "../src/store.ts";

const DB = join(tmpdir(), `stm-test-store-${process.pid}.sqlite`);
const KC = process.env.STM_KEYCHAIN_SERVICE || "subscribetome-test";

// Keep test keys out of the real "subscribetome" keychain service: every
// Store created below resolves keychainService() to KC, which afterAll cleans.
process.env.STM_KEYCHAIN_SERVICE = KC;

afterAll(() => {
  // Remove every keychain entry created under the test service.
  for (let i = 0; i < 100; i++) {
    try {
      execFileSync("/usr/bin/security", ["delete-generic-password", "-s", KC], {
        stdio: "ignore",
      });
    } catch {
      break;
    }
  }
  for (const s of ["", "-shm", "-wal"]) {
    try {
      rmSync(DB + s);
    } catch {
      /* ignore */
    }
  }
});

test("upsertTool inserts then updates without clobbering", () => {
  const s = new Store(DB);
  const t = s.upsertTool({ name: "OpenAI", displayName: "OpenAI", monthlyCost: 20 });
  expect(t.name).toBe("openai");
  expect(t.monthly_cost).toBe(20);
  const t2 = s.upsertTool({ name: "openai", plan: "Pro" });
  expect(t2.plan).toBe("Pro");
  expect(t2.monthly_cost).toBe(20); // preserved by COALESCE
  s.close();
});

test("addKey stores the value and resolve returns it", () => {
  const s = new Store(DB);
  const k = s.addKey({ tool: "anthropic", label: "default", value: "secret-value-xyz" });
  expect(k.placeholder).toBe("{{stm:anthropic:default}}");
  expect(s.resolve("anthropic", "default")).toBe("secret-value-xyz");
  expect(s.resolve("anthropic", "missing")).toBeNull();
  s.close();
});

test("duplicate label for the same tool is rejected", () => {
  const s = new Store(DB);
  s.addKey({ tool: "dup", label: "a", value: "v1" });
  expect(() => s.addKey({ tool: "dup", label: "a", value: "v2" })).toThrow();
  s.close();
});

test("revoke makes resolve return null", () => {
  const s = new Store(DB);
  s.addKey({ tool: "revtool", label: "default", value: "v" });
  expect(s.resolve("revtool", "default")).toBe("v");
  expect(s.revokeKey("revtool", "default")).toBe(true);
  expect(s.resolve("revtool", "default")).toBeNull();
  expect(s.revokeKey("revtool", "nope")).toBe(false);
  s.close();
});

test("activePlaceholders excludes revoked keys", () => {
  const s = new Store(DB);
  s.addKey({ tool: "act", label: "live", value: "v" });
  s.addKey({ tool: "act", label: "dead", value: "v" });
  s.revokeKey("act", "dead");
  const ph = s.activePlaceholders();
  expect(ph).toContain("{{stm:act:live}}");
  expect(ph).not.toContain("{{stm:act:dead}}");
  s.close();
});

test("monthlySpend sums tool costs", () => {
  const s = new Store(DB);
  const before = s.monthlySpend();
  s.upsertTool({ name: "spendy", monthlyCost: 99 });
  expect(s.monthlySpend()).toBe(before + 99);
  s.close();
});

test("setSubscription overwrites fields and can clear them", () => {
  const s = new Store(DB);
  s.upsertTool({ name: "subby", plan: "Pro", monthlyCost: 20, renewsOn: "2026-06-01" });

  // overwrite with new values
  expect(
    s.setSubscription({ name: "subby", plan: "Team", monthlyCost: 40, renewsOn: "2026-07-01" }),
  ).toBe(true);
  let t = s.getTool("subby")!;
  expect(t.plan).toBe("Team");
  expect(t.monthly_cost).toBe(40);
  expect(t.renews_on).toBe("2026-07-01");

  // null clears fields (upsertTool's COALESCE cannot do this)
  s.setSubscription({ name: "subby", plan: null, monthlyCost: null, renewsOn: null });
  t = s.getTool("subby")!;
  expect(t.plan).toBeNull();
  expect(t.monthly_cost).toBeNull();
  expect(t.renews_on).toBeNull();

  s.close();
});

test("setSubscription returns false for an unknown tool", () => {
  const s = new Store(DB);
  expect(
    s.setSubscription({ name: "ghost-tool", plan: "Pro", monthlyCost: 9, renewsOn: null }),
  ).toBe(false);
  s.close();
});

// ---- funding-card ledger (specs/public-product.md Phase 1) ---------------

test("assertCardLast4 accepts 4 digits, null, and empty; rejects everything else", () => {
  expect(assertCardLast4("4321")).toBe("4321");
  expect(assertCardLast4(null)).toBe(null);
  expect(assertCardLast4("")).toBe(null);
  expect(assertCardLast4(undefined)).toBe(null);
  // The load-bearing case: a full PAN must be REJECTED, not truncated.
  expect(() => assertCardLast4("4111111111111111")).toThrow(/4 digits/);
  expect(() => assertCardLast4("432")).toThrow();
  expect(() => assertCardLast4("43a1")).toThrow();
  expect(() => assertCardLast4(" 4321")).toThrow();
});

test("setSubscription stores and clears funding-card fields", () => {
  const s = new Store(DB);
  s.upsertTool({ name: "Runway", displayName: "Runway" });
  const ok = s.setSubscription({
    name: "runway",
    plan: "Unlimited",
    monthlyCost: 95,
    renewsOn: "2026-08-14",
    cardNickname: "Personal Amex",
    cardLast4: "4321",
    billingCadence: "monthly",
  });
  expect(ok).toBe(true);
  const t = s.getTool("runway")!;
  expect(t.card_nickname).toBe("Personal Amex");
  expect(t.card_last4).toBe("4321");
  expect(t.billing_cadence).toBe("monthly");
  // Passing null clears the card fields (the edit form's "remove" path).
  s.setSubscription({
    name: "runway",
    plan: "Unlimited",
    monthlyCost: 95,
    renewsOn: "2026-08-14",
    cardNickname: null,
    cardLast4: null,
    billingCadence: null,
  });
  const t2 = s.getTool("runway")!;
  expect(t2.card_nickname).toBe(null);
  expect(t2.card_last4).toBe(null);
  s.close();
});

test("setSubscription rejects a full PAN before writing", () => {
  const s = new Store(DB);
  s.upsertTool({ name: "ElevenLabs", displayName: "ElevenLabs" });
  expect(() =>
    s.setSubscription({
      name: "elevenlabs",
      plan: "Pro",
      monthlyCost: 22,
      renewsOn: null,
      cardLast4: "4111111111111111", // a full card number
    }),
  ).toThrow(/4 digits/);
  // Nothing should have been written to the card field.
  const t = s.getTool("elevenlabs")!;
  expect(t.card_last4).toBe(null);
  s.close();
});

test("new tools default the funding-card columns to null", () => {
  const s = new Store(DB);
  const t = s.upsertTool({ name: "PlainTool", displayName: "PlainTool" });
  expect(t.card_nickname).toBe(null);
  expect(t.card_last4).toBe(null);
  expect(t.billing_cadence).toBe(null);
  s.close();
});

test("renewalsDue: overdue, due-soon, and out-of-window sorting", () => {
  const s = new Store(DB);
  const ref = new Date(Date.UTC(2026, 6, 17)); // 2026-07-17
  s.upsertTool({ name: "overdue-sub" });
  s.setSubscription({ name: "overdue-sub", plan: null, monthlyCost: 10, renewsOn: "2026-07-10" });
  s.upsertTool({ name: "today-sub" });
  s.setSubscription({ name: "today-sub", plan: null, monthlyCost: 10, renewsOn: "2026-07-17" });
  s.upsertTool({ name: "soon-sub" });
  s.setSubscription({ name: "soon-sub", plan: null, monthlyCost: 10, renewsOn: "2026-07-24" });
  s.upsertTool({ name: "far-sub" });
  s.setSubscription({ name: "far-sub", plan: null, monthlyCost: 10, renewsOn: "2026-09-01" });
  s.upsertTool({ name: "no-renewal-sub" }); // no renews_on -> omitted

  const due = s.renewalsDue(14, ref);
  const names = due.map((d) => d.name);
  // far-sub (46d) is outside the 14d window; no-renewal-sub is omitted.
  expect(names).toEqual(["overdue-sub", "today-sub", "soon-sub"]);
  expect(due[0].days_until).toBe(-7); // overdue
  expect(due[1].days_until).toBe(0); // today
  expect(due[2].days_until).toBe(7);
  s.close();
});

test("renewalsDue: empty when nothing is within the window", () => {
  const s = new Store(DB);
  const ref = new Date(Date.UTC(2026, 0, 1));
  s.upsertTool({ name: "future-only" });
  s.setSubscription({ name: "future-only", plan: null, monthlyCost: 5, renewsOn: "2026-12-31" });
  expect(s.renewalsDue(30, ref)).toEqual([]);
  s.close();
});
