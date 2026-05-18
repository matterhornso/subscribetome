import { test, expect } from "bun:test";
import {
  findExact,
  findNearMisses,
  isExact,
  levenshtein,
  makePlaceholder,
  normalizeSegment,
  suggest,
} from "../src/grammar.ts";

test("findExact returns valid placeholders with tool/label", () => {
  const r = findExact("a {{stm:openai:default}} b {{stm:aws-s3:prod-1}} c");
  expect(r.map((p) => p.raw)).toEqual([
    "{{stm:openai:default}}",
    "{{stm:aws-s3:prod-1}}",
  ]);
  expect(r[0].tool).toBe("openai");
  expect(r[1].label).toBe("prod-1");
});

test("findExact ignores malformed forms", () => {
  expect(findExact("{{stm:bad}} {{ stm:x:y }} {{stm:UP:CASE}} {{stm::}}")).toEqual([]);
});

test("findNearMisses catches malformed stm blobs only", () => {
  const r = findNearMisses("ok {{stm:openai:default}} bad {{ stm:x }} {{stm:nope}}");
  expect(r.map((m) => m.raw)).toEqual(["{{ stm:x }}", "{{stm:nope}}"]);
});

test("isExact requires the whole string to be one placeholder", () => {
  expect(isExact("{{stm:openai:default}}")).toBe(true);
  expect(isExact("{{stm:openai:default}} trailing")).toBe(false);
  expect(isExact("{{ stm:openai:default }}")).toBe(false);
});

test("normalizeSegment lowercases and strips invalid chars", () => {
  expect(normalizeSegment("OpenAI Inc!!")).toBe("openai-inc");
  expect(normalizeSegment("  fal.ai  ")).toBe("fal-ai");
  expect(normalizeSegment("---")).toBe("");
});

test("levenshtein computes edit distance", () => {
  expect(levenshtein("kitten", "sitting")).toBe(3);
  expect(levenshtein("abc", "abc")).toBe(0);
});

test("suggest finds the closest known placeholder", () => {
  const known = ["{{stm:openai:default}}", "{{stm:aws:prod}}"];
  expect(suggest("{{stm:openai:defalt}}", known)).toBe("{{stm:openai:default}}");
  expect(suggest("totally-unrelated-string-here", known)).toBeNull();
});

test("makePlaceholder builds the canonical form", () => {
  expect(makePlaceholder("openai", "default")).toBe("{{stm:openai:default}}");
});
