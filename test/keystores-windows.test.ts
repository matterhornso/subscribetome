// Windows Credential Manager backend tests (v0.5.0).
//
// Build plan: specs/plans/v0.5-windows-backend.md.
//
// We CANNOT exercise the real bun:ffi binding against advapi32.dll on
// a macOS / Linux dev box — there is no advapi32 to dlopen, and even
// on a real Windows host we don't want to write into the user's
// Credential Manager from CI. So the backend takes an injectable
// `WincredFFI` and the tests pass a recording fake that mirrors the
// Win32 semantics closely enough (ERROR_NOT_FOUND on missing reads,
// idempotent delete on missing target, etc.).
//
// HEADLINE TEST: the secret value is never passed via any argv-shaped
// surface to the FFI. The Windows backend's load-bearing posture
// improvement over macOS — confirmed by inspecting the recorded
// `credWriteW` call and asserting the secret only ever appears as
// the BLOB byte parameter, not as a target-name string.

import { test, expect, beforeEach, afterAll } from "bun:test";
import {
  createWindowsCredentialKeyStore,
  isWincredReachable,
} from "../src/keystores/windows-credential.ts";
import {
  selectKeyStore,
  _resetKeyStoreCache,
} from "../src/keystores/index.ts";
import type { WincredFFI } from "../src/keystores/types.ts";

// Don't leak a forced backend into other test files (mirrors the
// pattern from test/keystores.test.ts).
beforeEach(() => _resetKeyStoreCache());
afterAll(() => _resetKeyStoreCache());

const ERROR_NOT_FOUND = 1168;

/**
 * A recording WincredFFI. Captures every call's arguments verbatim so
 * tests can assert the exact shape — argv equivalents on Linux and
 * macOS are positional strings; here it's the order of
 * credWriteW(targetName, blob) etc.
 */
function recordingFFI(opts?: {
  prefill?: Record<string, Uint8Array>;
  writeWillFail?: boolean;
  writeErrorCode?: number;
  readErrorCode?: number; // when set, reads return null + this code
  deleteWillFail?: boolean;
  deleteErrorCode?: number;
}): {
  ffi: WincredFFI;
  calls: Array<
    | { name: "credWriteW"; targetName: string; blob: Uint8Array }
    | { name: "credReadW"; targetName: string }
    | { name: "credDeleteW"; targetName: string }
    | { name: "lastError" }
  >;
  store: Map<string, Uint8Array>;
} {
  const calls: any[] = [];
  const store = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(opts?.prefill ?? {})) store.set(k, v);
  let lastErr = 0;
  return {
    calls,
    store,
    ffi: {
      credWriteW(targetName: string, blob: Uint8Array): boolean {
        // CRITICAL: stash a copy so later mutations don't taint the
        // recording. The headline test reads this back.
        calls.push({ name: "credWriteW", targetName, blob: new Uint8Array(blob) });
        if (opts?.writeWillFail) {
          lastErr = opts.writeErrorCode ?? 5; // ERROR_ACCESS_DENIED
          return false;
        }
        store.set(targetName, new Uint8Array(blob));
        lastErr = 0;
        return true;
      },
      credReadW(targetName: string): Uint8Array | null {
        calls.push({ name: "credReadW", targetName });
        if (opts?.readErrorCode != null) {
          lastErr = opts.readErrorCode;
          return null;
        }
        if (!store.has(targetName)) {
          lastErr = ERROR_NOT_FOUND;
          return null;
        }
        lastErr = 0;
        return store.get(targetName)!;
      },
      credDeleteW(targetName: string): boolean {
        calls.push({ name: "credDeleteW", targetName });
        if (opts?.deleteWillFail) {
          lastErr = opts.deleteErrorCode ?? 5;
          return false;
        }
        const had = store.delete(targetName);
        lastErr = had ? 0 : ERROR_NOT_FOUND;
        return had;
      },
      lastError(): number {
        calls.push({ name: "lastError" });
        return lastErr;
      },
    },
  };
}

// ---- HEADLINE TEST -------------------------------------------------------

test("WindowsCredential.set never passes the secret as the targetName (argv-equivalent)", () => {
  // The macOS backend's known limitation is `-w <value>` exposing the
  // secret via argv. Linux's `secret-tool store ... < stdin` closed
  // that. Windows closes it more cleanly: blob bytes are an FFI
  // parameter, target name is a separate string. This test pins the
  // separation: the targetName argument NEVER carries the value.
  const SECRET = "sk-this-must-only-appear-in-the-blob-bytes-AAAAA";
  const { ffi, calls } = recordingFFI();
  const ks = createWindowsCredentialKeyStore({ ffi });
  ks.set("ref-1", SECRET);
  const writeCalls = calls.filter((c) => c.name === "credWriteW");
  expect(writeCalls.length).toBe(1);
  // targetName carries only the namespace + ref, not the value.
  expect((writeCalls[0] as any).targetName).toBe("Subscribetome:ref-1");
  expect((writeCalls[0] as any).targetName).not.toContain(SECRET);
  // The value DOES live in the blob bytes — exactly where it belongs.
  const blob = (writeCalls[0] as any).blob as Uint8Array;
  const decoded = new TextDecoder().decode(blob);
  expect(decoded).toBe(SECRET);
});

// ---- set ----------------------------------------------------------------

test("WindowsCredential.set namespaces target as Subscribetome:<ref>", () => {
  const { ffi, calls } = recordingFFI();
  const ks = createWindowsCredentialKeyStore({ ffi });
  ks.set("alpha", "v");
  expect((calls[0] as any).targetName).toBe("Subscribetome:alpha");
});

test("WindowsCredential.set throws with the Win32 error code on failure", () => {
  const { ffi } = recordingFFI({ writeWillFail: true, writeErrorCode: 5 });
  const ks = createWindowsCredentialKeyStore({ ffi });
  expect(() => ks.set("x", "v")).toThrow(/Win32 error 5/);
});

test("WindowsCredential.set encodes the value as UTF-8 bytes", () => {
  const { ffi, calls } = recordingFFI();
  const ks = createWindowsCredentialKeyStore({ ffi });
  ks.set("u8", "héllo-world-§ÿ");
  const blob = (calls[0] as any).blob as Uint8Array;
  // Round-trip through TextDecoder to confirm the bytes are valid UTF-8
  // and decode back to the original (DPAPI does no string interp).
  expect(new TextDecoder("utf-8").decode(blob)).toBe("héllo-world-§ÿ");
});

// ---- get ----------------------------------------------------------------

test("WindowsCredential.get returns the value when present", () => {
  const { ffi, store } = recordingFFI();
  store.set("Subscribetome:r", new TextEncoder().encode("the-value"));
  const ks = createWindowsCredentialKeyStore({ ffi });
  expect(ks.get("r")).toBe("the-value");
});

test("WindowsCredential.get returns null on ERROR_NOT_FOUND (1168)", () => {
  const { ffi } = recordingFFI(); // empty store
  const ks = createWindowsCredentialKeyStore({ ffi });
  expect(ks.get("ghost")).toBeNull();
});

test("WindowsCredential.get throws on a non-NOT_FOUND error code", () => {
  // Synthesize a real failure: API call returns null + last error is
  // something other than ERROR_NOT_FOUND. The backend bubbles it up
  // instead of pretending the secret is absent.
  const { ffi } = recordingFFI({ readErrorCode: 5 }); // ERROR_ACCESS_DENIED
  const ks = createWindowsCredentialKeyStore({ ffi });
  expect(() => ks.get("r")).toThrow(/Win32 error 5/);
});

test("WindowsCredential round-trips: set then get", () => {
  const { ffi } = recordingFFI();
  const ks = createWindowsCredentialKeyStore({ ffi });
  ks.set("rt", "the-secret");
  expect(ks.get("rt")).toBe("the-secret");
});

// ---- delete -------------------------------------------------------------

test("WindowsCredential.delete is idempotent (ERROR_NOT_FOUND is OK)", () => {
  const { ffi } = recordingFFI();
  const ks = createWindowsCredentialKeyStore({ ffi });
  // No throw even though the target was never inserted.
  expect(() => ks.delete("never-existed")).not.toThrow();
});

test("WindowsCredential.delete removes a present target then makes get return null", () => {
  const { ffi } = recordingFFI();
  const ks = createWindowsCredentialKeyStore({ ffi });
  ks.set("d", "v");
  ks.delete("d");
  expect(ks.get("d")).toBeNull();
});

test("WindowsCredential.delete throws on a real failure (not NOT_FOUND)", () => {
  const { ffi } = recordingFFI({ deleteWillFail: true, deleteErrorCode: 1314 });
  const ks = createWindowsCredentialKeyStore({ ffi });
  expect(() => ks.delete("anything")).toThrow(/Win32 error 1314/);
});

// ---- describe -----------------------------------------------------------

test("WindowsCredential.describe identifies as DPAPI-backed", () => {
  const ks = createWindowsCredentialKeyStore({ ffi: recordingFFI().ffi });
  expect(ks.describe()).toBe("Windows Credential Manager (DPAPI)");
});

// ---- isWincredReachable -------------------------------------------------

test("isWincredReachable returns true when the probe completes (ERROR_NOT_FOUND on absent target)", () => {
  const { ffi } = recordingFFI(); // empty store → probe returns null + 1168
  expect(isWincredReachable({ ffi })).toBe(true);
});

test("isWincredReachable returns false when the FFI throws (advapi32 unloadable)", () => {
  const broken: WincredFFI = {
    credWriteW: () => { throw new Error("advapi32 missing"); },
    credReadW: () => { throw new Error("advapi32 missing"); },
    credDeleteW: () => { throw new Error("advapi32 missing"); },
    lastError: () => 0,
  };
  expect(isWincredReachable({ ffi: broken })).toBe(false);
});

test("isWincredReachable returns false when the FFI returns null with a non-NOT_FOUND error code", () => {
  // E.g. ERROR_NO_SUCH_LOGON_SESSION (1312) — service unreachable.
  const { ffi } = recordingFFI({ readErrorCode: 1312 });
  expect(isWincredReachable({ ffi })).toBe(false);
});

// ---- resolver integration -----------------------------------------------

test("selectKeyStore picks the Windows backend on win32 with a reachable FFI", () => {
  const { ffi } = recordingFFI();
  const ks = selectKeyStore({
    force: true,
    platform: "win32" as any,
    env: {},
    wincredFFI: ffi,
  });
  expect(ks.describe()).toBe("Windows Credential Manager (DPAPI)");
});

test("selectKeyStore on win32 with an unreachable FFI returns an honest unsupported store", () => {
  const broken: WincredFFI = {
    credWriteW: () => { throw new Error("nope"); },
    credReadW: () => { throw new Error("nope"); },
    credDeleteW: () => { throw new Error("nope"); },
    lastError: () => 0,
  };
  const ks = selectKeyStore({
    force: true,
    platform: "win32" as any,
    env: {},
    wincredFFI: broken,
  });
  expect(ks.describe()).toContain("unreachable");
  // The spec's "never silently fall back" invariant: every op throws.
  expect(() => ks.set("r", "v")).toThrow(/no usable keystore/);
  expect(() => ks.get("r")).toThrow(/no usable keystore/);
  expect(() => ks.delete("r")).toThrow(/no usable keystore/);
});

test("STM_KEYSTORE=wincred override beats the platform default", () => {
  // On a Linux platform, the override is what's exercised.
  const { ffi } = recordingFFI();
  const ks = selectKeyStore({
    force: true,
    platform: "linux",
    env: { STM_KEYSTORE: "wincred" },
    wincredFFI: ffi,
  });
  expect(ks.describe()).toBe("Windows Credential Manager (DPAPI)");
});

// ---- describe-without-FFI invariant -------------------------------------

test("describe() does not need a working FFI (lazy resolution)", () => {
  // Construct WITHOUT injecting an FFI on a non-Windows platform.
  // The backend's eager FFI bind would throw — the lazy form must
  // not. `describe()` exists so the dashboard pill / status output
  // can render even on a misconfigured host, with the actual
  // failure surfaced at the first real op.
  expect(() => {
    const ks = createWindowsCredentialKeyStore();
    expect(ks.describe()).toBe("Windows Credential Manager (DPAPI)");
  }).not.toThrow();
});

// ---- multi-key isolation ------------------------------------------------

test("two refs are stored independently (no cross-contamination)", () => {
  const { ffi } = recordingFFI();
  const ks = createWindowsCredentialKeyStore({ ffi });
  ks.set("k1", "alpha");
  ks.set("k2", "bravo");
  expect(ks.get("k1")).toBe("alpha");
  expect(ks.get("k2")).toBe("bravo");
  ks.delete("k1");
  expect(ks.get("k1")).toBeNull();
  expect(ks.get("k2")).toBe("bravo");
});

// ---- large value --------------------------------------------------------

test("WindowsCredential handles a 2KB value (typical API key size)", () => {
  // Credential Manager's blob limit is 2560 bytes; API keys are
  // ~50–500 bytes in practice. 2KB is comfortably under the limit
  // and well above any real key.
  const big = "x".repeat(2048);
  const { ffi } = recordingFFI();
  const ks = createWindowsCredentialKeyStore({ ffi });
  ks.set("big", big);
  expect(ks.get("big")).toBe(big);
});

// ---- Headline reaffirmation across set + get ----------------------------

test("end-to-end: secret never appears in any argv-shaped FFI parameter, even on get", () => {
  const SECRET = "sk-still-not-in-argv-XXXXX";
  const { ffi, calls } = recordingFFI();
  const ks = createWindowsCredentialKeyStore({ ffi });
  ks.set("e2e", SECRET);
  ks.get("e2e");
  ks.delete("e2e");
  // No string-shaped FFI parameter (targetName) ever carries the value.
  for (const c of calls) {
    if ("targetName" in c) {
      expect(c.targetName).not.toContain(SECRET);
    }
  }
});
