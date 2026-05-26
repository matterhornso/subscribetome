// macOS Keychain real-FFI smoke test.
//
// v0.6.1's main test file uses an injected MacFFI so it can run
// cross-platform. That left the actual realMacFFI() path — including
// the CFRelease cleanup added in v0.7.2 — without coverage.
//
// This file rounds-trips set → get → delete against the real macOS
// Security framework. Darwin-only; everywhere else it skips. We
// override STM_KEYCHAIN_SERVICE so the entries land in a sandbox
// service and we clean them up after.

import { test, expect, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { createMacKeyStore } from "../src/keystores/mac.ts";

const KC = "subscribetome-test-realffi";
process.env.STM_KEYCHAIN_SERVICE = KC;

const isDarwin = process.platform === "darwin";
const t = isDarwin ? test : test.skip;

afterAll(() => {
  // Best-effort cleanup of anything we wrote, in case a test threw.
  for (let i = 0; i < 50; i++) {
    try {
      execFileSync("/usr/bin/security", ["delete-generic-password", "-s", KC], {
        stdio: "ignore",
      });
    } catch {
      break;
    }
  }
});

t("realFFI: set → get → delete round-trip", () => {
  const store = createMacKeyStore();
  const ref = `realffi-${process.pid}-1`;
  const secret = "rtt-" + Math.random().toString(36).slice(2);

  store.set(ref, secret);
  expect(store.get(ref)).toBe(secret);
  store.delete(ref);
  expect(store.get(ref)).toBeNull();
  // Second delete on a missing entry is a no-op — exercises the
  // errSecItemNotFound branch on the real FFI without throwing.
  store.delete(ref);
});

t("realFFI: upsert overwrites an existing entry", () => {
  const store = createMacKeyStore();
  const ref = `realffi-${process.pid}-2`;
  store.set(ref, "first");
  store.set(ref, "second");
  expect(store.get(ref)).toBe("second");
  store.delete(ref);
});

t("realFFI: delete then re-add works (CFRelease leak fix sanity)", () => {
  // Before the v0.7.2 CFRelease fix, the itemRef returned by find
  // was leaked after SecKeychainItemDelete. The functional behavior
  // didn't change — the OS cleaned it up at process exit — but we
  // want to confirm that adding CFRelease didn't break the
  // delete→re-add path (a use-after-free would manifest here).
  const store = createMacKeyStore();
  const ref = `realffi-${process.pid}-3`;
  for (let i = 0; i < 3; i++) {
    store.set(ref, `v${i}`);
    expect(store.get(ref)).toBe(`v${i}`);
    store.delete(ref);
  }
});

t("realFFI: binary-safe blob (multibyte UTF-8)", () => {
  const store = createMacKeyStore();
  const ref = `realffi-${process.pid}-4`;
  // Greek + Japanese + emoji — exercises that we copy bytes verbatim
  // rather than going through a length-1-per-char path anywhere.
  const secret = "λ-日本-🔑-" + Math.random().toString(36).slice(2);
  store.set(ref, secret);
  expect(store.get(ref)).toBe(secret);
  store.delete(ref);
});

t("realFFI: get on missing entry returns null", () => {
  const store = createMacKeyStore();
  const ref = `realffi-${process.pid}-missing-${Math.random().toString(36).slice(2)}`;
  expect(store.get(ref)).toBeNull();
});
