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

test("findNearMisses catches a stray inner brace (was a silent slip)", () => {
  // {{stm:fal:de{fault}} is neither a valid placeholder nor a clean {{...}}
  // blob — the old blob regex missed it entirely, so the user got no
  // did-you-mean and the command ran with a broken literal.
  const r = findNearMisses("cat {{stm:fal:de{fault}}");
  expect(r.map((m) => m.raw)).toEqual(["{{stm:fal:de{fault}}"]);
});

test("findNearMisses catches a missing closing brace", () => {
  const r = findNearMisses("export K={{stm:fal:default}");
  expect(r.map((m) => m.raw)).toEqual(["{{stm:fal:default}"]);
});

test("findNearMisses flags a malformed placeholder even next to a valid one", () => {
  // The valid one still parses as exact; the malformed one is surfaced so
  // PreToolUse blocks the whole command instead of substituting the good key
  // and passing the broken one through as a silent literal.
  const cmd = "echo {{stm:openai:default}} && cat {{stm:fal:de{fault}}";
  expect(findExact(cmd).map((p) => p.raw)).toEqual(["{{stm:openai:default}}"]);
  expect(findNearMisses(cmd).map((m) => m.raw)).toEqual(["{{stm:fal:de{fault}}"]);
});

test("findNearMisses caps a runaway unclosed opener", () => {
  // A stray "{{stm" with no close must not swallow the whole command into the
  // suggestion snippet — it is bounded to a fixed window.
  const cmd = "{{stm" + "x".repeat(500);
  const r = findNearMisses(cmd);
  expect(r).toHaveLength(1);
  expect(r[0].raw.length).toBeLessThanOrEqual(128);
});

test("findNearMisses does not flag ordinary shell brace usage", () => {
  // No "{{stm" opener → nothing flagged. Guards against false positives on
  // brace expansion / JSON in commands.
  expect(findNearMisses("echo {a,b,c} && jq '{x: .y}'")).toEqual([]);
  expect(findNearMisses("printf '%s' {{1..3}}")).toEqual([]);
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
