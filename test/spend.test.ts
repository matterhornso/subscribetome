// Spend-visibility tests (specs/spend-visibility.md).
//
// Three layers:
//   1. Store: spend table + monthlySpend(Breakdown) semantics.
//   2. Provider: OpenAI + Anthropic implementations, parser logic
//      exercised against synthetic responses via injected fetch.
//   3. Orchestrator (sync.ts): credential resolution, error
//      preservation rule ("never silently zero out a previous good
//      value"), per-provider isolation when one fails.

import { test, expect, afterAll, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { PROVIDERS, listProviderIds, currentMonthWindow } from "../src/providers/index.ts";
import { syncOne, syncProvider, syncAll } from "../src/sync.ts";
import { CATALOG } from "../src/catalog.ts";

// ---- Store: spend table semantics ---------------------------------------

const STORE_DB = join(tmpdir(), `stm-test-spend-store-${process.pid}.sqlite`);
const STORE_KC = `subscribetome-test-spend-store-${process.pid}`;

beforeAll(() => {
  process.env.STM_KEYCHAIN_SERVICE = STORE_KC;
});

afterAll(() => {
  for (let i = 0; i < 100; i++) {
    try {
      execFileSync("/usr/bin/security", ["delete-generic-password", "-s", STORE_KC], {
        stdio: "ignore",
      });
    } catch {
      break;
    }
  }
  for (const s of ["", "-shm", "-wal"]) {
    try { rmSync(STORE_DB + s); } catch { /* ignore */ }
  }
});

test("Store.setSpend writes a fetched row that getSpend round-trips", () => {
  const s = new Store(STORE_DB);
  try {
    const tool = s.upsertTool({ name: "openai" });
    s.setSpend({ toolId: tool.id, usd: 42.5, asOf: "2026-05-23T10:00:00Z" });
    const row = s.getSpend(tool.id);
    expect(row?.fetched_usd).toBe(42.5);
    expect(row?.source).toBe("fetched");
    expect(row?.last_error).toBeNull();
  } finally { s.close(); }
});

test("Store.setSpend rejects negative or non-finite values", () => {
  const s = new Store(STORE_DB);
  try {
    const tool = s.upsertTool({ name: "anthropic" });
    expect(() => s.setSpend({ toolId: tool.id, usd: -1, asOf: "x" })).toThrow();
    expect(() => s.setSpend({ toolId: tool.id, usd: Number.NaN, asOf: "x" })).toThrow();
  } finally { s.close(); }
});

test("Store.markSpendError preserves the previous fetched_usd (no silent zero)", () => {
  const s = new Store(STORE_DB);
  try {
    const tool = s.upsertTool({ name: "openai" });
    // first, a good fetch
    s.setSpend({ toolId: tool.id, usd: 99.99, asOf: "2026-05-23T10:00:00Z" });
    // then an error
    s.markSpendError(tool.id, "HTTP 503");
    const row = s.getSpend(tool.id);
    // The previous good value is preserved
    expect(row?.fetched_usd).toBe(99.99);
    expect(row?.source).toBe("error");
    expect(row?.last_error).toBe("HTTP 503");
  } finally { s.close(); }
});

test("Store.markSpendError on a never-fetched tool yields a NULL usd row", () => {
  const s = new Store(STORE_DB);
  try {
    const tool = s.upsertTool({ name: "groq" });
    s.markSpendError(tool.id, "missing credential");
    const row = s.getSpend(tool.id);
    expect(row?.fetched_usd).toBeNull();
    expect(row?.source).toBe("error");
    expect(row?.last_error).toBe("missing credential");
  } finally { s.close(); }
});

test("Store.monthlySpend prefers fetched_usd over manual monthly_cost", () => {
  const s = new Store(STORE_DB);
  try {
    // Start clean — earlier tests may have left rows
    s.db.exec(`DELETE FROM spend`);
    s.db.exec(`DELETE FROM tools`);
    const a = s.upsertTool({ name: "fetched-only", plan: null, monthlyCost: 5 });
    const b = s.upsertTool({ name: "manual-only", plan: null, monthlyCost: 7 });
    const c = s.upsertTool({ name: "both", plan: null, monthlyCost: 10 });
    s.setSpend({ toolId: a.id, usd: 11, asOf: "x" });
    s.setSpend({ toolId: c.id, usd: 50, asOf: "x" });
    // a contributes 11 (fetched overrides manual 5), b contributes 7, c contributes 50
    expect(s.monthlySpend()).toBeCloseTo(11 + 7 + 50, 5);
  } finally { s.close(); }
});

test("Store.monthlySpendBreakdown reports fetched/manual split", () => {
  const s = new Store(STORE_DB);
  try {
    const b = s.monthlySpendBreakdown();
    expect(b.fetched).toBeCloseTo(11 + 50, 5);
    expect(b.manual).toBeCloseTo(7, 5);
    expect(b.fetchedTools).toBe(2);
    expect(b.manualTools).toBe(1);
    expect(b.total).toBeCloseTo(b.fetched + b.manual, 5);
  } finally { s.close(); }
});

test("Store schema migration is idempotent (spend table)", () => {
  // Open twice — second open re-runs SCHEMA + migrations and must be a no-op.
  const s1 = new Store(STORE_DB); s1.close();
  const s2 = new Store(STORE_DB);
  try {
    const t = s2.upsertTool({ name: "idem-check" });
    expect(() => s2.setSpend({ toolId: t.id, usd: 1, asOf: "x" })).not.toThrow();
  } finally { s2.close(); }
});

// ---- Catalog ↔ providers invariant --------------------------------------

test("every catalog supportsUsage entry has a matching provider in PROVIDERS", () => {
  for (const svc of CATALOG) {
    if (!svc.supportsUsage) continue;
    expect(PROVIDERS[svc.id]).toBeDefined();
    // The catalog's declared usage label must match the provider's
    // requested label — otherwise the orchestrator would look up the
    // wrong key in the keychain.
    expect(svc.usageCredentialLabel).toBe(PROVIDERS[svc.id].usageCredentialLabel);
  }
});

test("listProviderIds returns the registered set", () => {
  const ids = listProviderIds();
  expect(ids).toContain("openai");
  expect(ids).toContain("anthropic");
});

test("currentMonthWindow returns Unix seconds for the start of UTC month", () => {
  const fixed = new Date("2026-05-23T10:30:00Z");
  const { startUnix, endUnix } = currentMonthWindow(fixed);
  expect(startUnix).toBe(Math.floor(Date.UTC(2026, 4, 1, 0, 0, 0, 0) / 1000));
  expect(endUnix).toBe(Math.floor(fixed.getTime() / 1000));
});

// ---- OpenAI provider parser ---------------------------------------------

test("openaiProvider.current sums every result.amount.value in every bucket", async () => {
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    expect(u).toContain("api.openai.com/v1/organization/costs");
    expect((init?.headers as any).Authorization).toBe("Bearer test-admin-key");
    return new Response(JSON.stringify({
      object: "page",
      data: [
        { object: "bucket", results: [{ amount: { value: 1.25, currency: "usd" } }] },
        { object: "bucket", results: [
          { amount: { value: 2.50, currency: "usd" } },
          { amount: { value: 0.05, currency: "usd" } },
        ]},
      ],
    }), { status: 200, headers: { "content-type": "application/json" }});
  }) as unknown as typeof fetch;
  const r = await openaiProvider.current("test-admin-key", { fetch: fakeFetch });
  expect(r.monthlyToDateUSD).toBeCloseTo(3.80, 5);
  expect(r.asOf.length).toBeGreaterThan(0);
});

test("openaiProvider.current throws on HTTP 401", async () => {
  const fakeFetch = (async () =>
    new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
  await expect(openaiProvider.current("bad-key", { fetch: fakeFetch })).rejects.toThrow(/auth/);
});

test("openaiProvider.current throws on HTTP 429", async () => {
  const fakeFetch = (async () =>
    new Response("slow down", { status: 429 })) as unknown as typeof fetch;
  await expect(openaiProvider.current("k", { fetch: fakeFetch })).rejects.toThrow(/rate/);
});

test("openaiProvider.current tolerates an empty data array (returns 0)", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
  const r = await openaiProvider.current("k", { fetch: fakeFetch });
  expect(r.monthlyToDateUSD).toBe(0);
});

test("openaiProvider.current throws on missing usage key", async () => {
  await expect(openaiProvider.current("", { fetch })).rejects.toThrow(/admin key/);
});

// ---- Anthropic provider parser ------------------------------------------

test("anthropicProvider.current sums both direct and results-style amounts", async () => {
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    expect(u).toContain("api.anthropic.com/v1/organizations/cost_report");
    expect((init?.headers as any)["x-api-key"]).toBe("test-anthropic-key");
    expect((init?.headers as any)["anthropic-version"]).toBe("2023-06-01");
    return new Response(JSON.stringify({
      data: [
        { amount: { value: 10.00, currency: "usd" } },
        { results: [{ amount: { value: 5.00, currency: "usd" } }] },
      ],
    }), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await anthropicProvider.current("test-anthropic-key", { fetch: fakeFetch });
  expect(r.monthlyToDateUSD).toBeCloseTo(15.0, 5);
});

test("anthropicProvider.current throws on HTTP 401", async () => {
  const fakeFetch = (async () =>
    new Response("nope", { status: 401 })) as unknown as typeof fetch;
  await expect(anthropicProvider.current("bad", { fetch: fakeFetch })).rejects.toThrow(/auth/);
});

// ---- Orchestrator (sync.ts) ---------------------------------------------

const SYNC_DB = join(tmpdir(), `stm-test-spend-sync-${process.pid}.sqlite`);
const SYNC_KC = `subscribetome-test-spend-sync-${process.pid}`;

afterAll(() => {
  for (let i = 0; i < 100; i++) {
    try {
      execFileSync("/usr/bin/security", ["delete-generic-password", "-s", SYNC_KC], {
        stdio: "ignore",
      });
    } catch { break; }
  }
  for (const s of ["", "-shm", "-wal"]) {
    try { rmSync(SYNC_DB + s); } catch { /* ignore */ }
  }
});

test("syncOne writes a fetched row and returns ok:true on success", async () => {
  process.env.STM_KEYCHAIN_SERVICE = SYNC_KC;
  const store = new Store(SYNC_DB);
  // Seed the admin-key in the keychain so the orchestrator can resolve it.
  store.addKey({ tool: "openai", label: "admin-key", value: "sk-admin-fixture" });
  const fakeFetch = (async () =>
    new Response(JSON.stringify({
      data: [{ results: [{ amount: { value: 73.10, currency: "usd" } }] }],
    }), { status: 200 })) as unknown as typeof fetch;
  const r = await syncOne(openaiProvider, { store, fetch: fakeFetch });
  expect(r.ok).toBe(true);
  expect(r.usd).toBeCloseTo(73.10, 5);
  const row = store.getSpend(store.getTool("openai")!.id);
  expect(row?.fetched_usd).toBeCloseTo(73.10, 5);
  expect(row?.source).toBe("fetched");
  store.close();
});

test("syncOne with no usage credential returns missingCredential:true and does NOT touch the network", async () => {
  process.env.STM_KEYCHAIN_SERVICE = SYNC_KC;
  const store = new Store(SYNC_DB);
  // No anthropic admin-key has been stored.
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const r = await syncOne(anthropicProvider, { store, fetch: fakeFetch });
  expect(r.ok).toBe(false);
  expect(r.missingCredential).toBe(true);
  expect(called).toBe(false); // posture rule: no outbound call without a credential
  store.close();
});

test("syncOne on provider failure preserves the previous good value", async () => {
  process.env.STM_KEYCHAIN_SERVICE = SYNC_KC;
  const store = new Store(SYNC_DB);
  // openai admin-key already exists from the earlier test
  const okFetch = (async () =>
    new Response(JSON.stringify({
      data: [{ results: [{ amount: { value: 12.34, currency: "usd" } }] }],
    }), { status: 200 })) as unknown as typeof fetch;
  await syncOne(openaiProvider, { store, fetch: okFetch });

  const badFetch = (async () =>
    new Response("server error", { status: 500 })) as unknown as typeof fetch;
  const r = await syncOne(openaiProvider, { store, fetch: badFetch });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/HTTP 500/);

  const row = store.getSpend(store.getTool("openai")!.id);
  // Load-bearing: previous fetched_usd is intact, source flipped to "error".
  expect(row?.fetched_usd).toBeCloseTo(12.34, 5);
  expect(row?.source).toBe("error");
  expect(row?.last_error).toMatch(/HTTP 500/);
  store.close();
});

test("syncAll runs every registered provider independently (one failure does not block the others)", async () => {
  process.env.STM_KEYCHAIN_SERVICE = SYNC_KC;
  const store = new Store(SYNC_DB);
  // openai admin-key already exists; seed anthropic too so both run.
  store.addKey({ tool: "anthropic", label: "admin-key", value: "sk-ant-admin-fixture" });
  const fakeFetch = (async (url: string | URL) => {
    if (String(url).includes("openai.com")) {
      return new Response(JSON.stringify({
        data: [{ results: [{ amount: { value: 10, currency: "usd" } }] }],
      }), { status: 200 });
    }
    // Anthropic fails
    return new Response("oops", { status: 500 });
  }) as unknown as typeof fetch;
  const rows = await syncAll({ store, fetch: fakeFetch });
  expect(rows.length).toBe(2);
  const oa = rows.find((r) => r.tool === "openai")!;
  const an = rows.find((r) => r.tool === "anthropic")!;
  expect(oa.ok).toBe(true);
  expect(an.ok).toBe(false);
  store.close();
});

test("syncProvider returns null for an unknown id", async () => {
  const r = await syncProvider("not-a-real-provider", { store: new Store(SYNC_DB) });
  expect(r).toBeNull();
});
