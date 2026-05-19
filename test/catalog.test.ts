import { test, expect } from "bun:test";
import { CATALOG } from "../src/catalog.ts";

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
