import { test, expect, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";

const DB = join(tmpdir(), `stm-test-store-${process.pid}.sqlite`);
const KC = process.env.STM_KEYCHAIN_SERVICE || "subscribetome-test";

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
