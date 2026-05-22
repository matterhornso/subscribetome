import { test, expect } from "bun:test";
import { CATALOG, CATEGORY_LABEL, CATEGORY_ORDER } from "../src/catalog.ts";

// Placeholder grammar: a segment is lowercase a-z, 0-9, hyphen, 1-64 chars.
const SEG = /^[a-z0-9-]{1,64}$/;

test("every catalog service has a grammar-valid id and credential labels", () => {
  expect(CATALOG.length).toBeGreaterThan(0);
  const ids = new Set<string>();
  for (const s of CATALOG) {
    expect(s.id).toMatch(SEG);
    expect(ids.has(s.id)).toBe(false); // ids are unique
    ids.add(s.id);
    expect(s.name.trim().length).toBeGreaterThan(0);
    expect(s.credentials.length).toBeGreaterThan(0);
    const labels = new Set<string>();
    for (const lbl of s.credentials) {
      expect(lbl).toMatch(SEG);
      expect(labels.has(lbl)).toBe(false); // labels unique within a service
      labels.add(lbl);
    }
  }
});

test("catalog covers the services the dashboard advertises", () => {
  const ids = new Set(CATALOG.map((s) => s.id));
  for (const id of ["supabase", "twitter", "telegram", "railway", "clerk"]) {
    expect(ids.has(id)).toBe(true);
  }
  const twitter = CATALOG.find((s) => s.id === "twitter")!;
  expect(twitter.credentials).toContain("bearer-token");
});

// ---- v0.2.6: catalog browser ---------------------------------------------

test("catalog has exactly 50 entries after the catalog-browser expansion", () => {
  expect(CATALOG.length).toBe(50);
});

test("every catalog service has a category and a url", () => {
  for (const s of CATALOG) {
    expect(typeof s.category).toBe("string");
    expect(CATEGORY_ORDER.includes(s.category)).toBe(true);
    expect(typeof s.url).toBe("string");
    expect(s.url.length).toBeGreaterThan(0);
    expect(s.url.startsWith("https://")).toBe(true);
  }
});

test("every category in CATEGORY_ORDER has a display label", () => {
  for (const c of CATEGORY_ORDER) {
    expect(typeof CATEGORY_LABEL[c]).toBe("string");
    expect(CATEGORY_LABEL[c].trim().length).toBeGreaterThan(0);
  }
});

test("the 14 net-new entries are all present with their canonical ids", () => {
  // From specs/service-catalog-browser.md §4.1 — the 14 services this
  // release adds. The test pins ids so a future rename gets noticed.
  const expectedNew = [
    "apollo",
    "postiz",
    "typefully",
    "linear",
    "notion",
    "brevo",
    "mailgun",
    "postmark",
    "planetscale",
    "fly",
    "lemon-squeezy",
    "paddle",
    "clay",
    "digitalocean",
  ];
  const ids = new Set(CATALOG.map((s) => s.id));
  for (const id of expectedNew) {
    expect(ids.has(id)).toBe(true);
  }
});

test("category distribution roughly matches the spec taxonomy", () => {
  // Sanity check that we have at least one service in each declared
  // category — guards against a typo in a category string that would
  // create an empty bucket in the dashboard.
  const counts: Record<string, number> = {};
  for (const s of CATALOG) counts[s.category] = (counts[s.category] ?? 0) + 1;
  for (const c of CATEGORY_ORDER) {
    expect(counts[c] ?? 0).toBeGreaterThan(0);
  }
});
