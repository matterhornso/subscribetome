import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanEnv } from "../src/import.ts";

const dir = mkdtempSync(join(tmpdir(), "stm-imp-"));
writeFileSync(
  join(dir, ".env"),
  [
    "OPENAI_API_KEY=sk-abcdefghij1234567890klmnopqrst",
    "AWS_SECRET=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
    "DEBUG=true",
    "PORT=3000",
    "ALREADY=v={{stm:openai:default}}",
  ].join("\n"),
);

afterAll(() => {
  try {
    rmSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
});

test("scanEnv finds key-shaped vars and skips non-keys", () => {
  const names = scanEnv([dir]).map((c) => c.varName);
  expect(names).toContain("OPENAI_API_KEY");
  expect(names).toContain("AWS_SECRET");
  expect(names).not.toContain("DEBUG");
  expect(names).not.toContain("PORT");
});

test("scanEnv skips values that are already placeholders", () => {
  expect(scanEnv([dir]).map((c) => c.varName)).not.toContain("ALREADY");
});

test("scanEnv suggests a clean tool name and masks the value", () => {
  const openai = scanEnv([dir]).find((c) => c.varName === "OPENAI_API_KEY");
  expect(openai?.suggestedTool).toBe("openai");
  expect(openai?.valueMasked).not.toContain("abcdefghij1234567890");
});
