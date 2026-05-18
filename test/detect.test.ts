import { test, expect } from "bun:test";
import { detectKeys } from "../src/detect.ts";

test("detects provider-prefixed keys", () => {
  expect(
    detectKeys("token sk-ant-abcdefghij1234567890XYZ rest").some(
      (h) => h.kind === "anthropic",
    ),
  ).toBe(true);
  expect(
    detectKeys("AKIAIOSFODNN7EXAMPLE").some((h) => h.kind === "aws-access-key-id"),
  ).toBe(true);
  expect(
    detectKeys("ghp_0123456789abcdefghijklmnopqrstuvwxyz").some(
      (h) => h.kind === "github-token",
    ),
  ).toBe(true);
});

test("ignores hex hashes and UUIDs", () => {
  expect(detectKeys("commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")).toEqual([]);
  expect(detectKeys("id 550e8400-e29b-41d4-a716-446655440000")).toEqual([]);
});

test("ignores ordinary prose", () => {
  expect(detectKeys("please run the test suite and report the results")).toEqual([]);
});

test("flags a high-entropy mixed token", () => {
  // 36-char mixed alphanumeric — above the detector's 32-char floor.
  expect(
    detectKeys("val Xk29Lp01Qz84Rt56Yb73Mn48Wc92DfHq47bS").length,
  ).toBeGreaterThan(0);
});
