// macOS Keychain backend tests — v0.6.1 FFI rewrite.
//
// The v1 backend shelled out to `/usr/bin/security` with the secret
// in argv (v1 limitation called out in the spec). v0.6.1 replaces
// that with the macOS Security framework via Bun FFI: the secret
// bytes live in a Uint8Array we own and pass to
// SecKeychainAddGenericPassword by pointer.
//
// We test via an injected MacFFI (Windows backend pattern), so the
// suite runs on any host without writing into the real Keychain.
// The HEADLINE TEST asserts what the patch is actually for: no
// string-shaped FFI parameter ever carries the secret value.

import { test, expect, beforeEach, afterAll } from "bun:test";
import {
  createMacKeyStore,
  isMacKeychainReachable,
} from "../src/keystores/mac.ts";
import {
  selectKeyStore,
  _resetKeyStoreCache,
} from "../src/keystores/index.ts";
import type { MacFFI } from "../src/keystores/types.ts";

beforeEach(() => _resetKeyStoreCache());
afterAll(() => _resetKeyStoreCache());

const errSecItemNotFound = -25300;
const errSecDuplicateItem = -25299;

/**
 * Recording MacFFI. Captures every call's positional args so the
 * headline test can assert no string param ever carries the secret
 * value.
 */
function recordingFFI(opts?: {
  prefill?: Record<string, Uint8Array>;
  addWillFail?: boolean;
  addErrorCode?: number;
  /** First add fails with errSecDuplicateItem; second succeeds. */
  addDuplicateThenSucceed?: boolean;
  findErrorCode?: number;
  deleteWillFail?: boolean;
  deleteErrorCode?: number;
}): {
  ffi: MacFFI;
  calls: Array<
    | { name: "addGenericPassword"; service: string; account: string; blob: Uint8Array }
    | { name: "findGenericPassword"; service: string; account: string }
    | { name: "deleteGenericPassword"; service: string; account: string }
    | { name: "lastStatus" }
  >;
  store: Map<string, Uint8Array>;
} {
  const calls: any[] = [];
  const store = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(opts?.prefill ?? {})) store.set(k, v);
  let lastStatus = 0;
  let addCallCount = 0;
  return {
    calls,
    store,
    ffi: {
      addGenericPassword(service: string, account: string, blob: Uint8Array): boolean {
        addCallCount++;
        calls.push({
          name: "addGenericPassword",
          service,
          account,
          blob: new Uint8Array(blob),
        });
        if (opts?.addDuplicateThenSucceed && addCallCount === 1) {
          lastStatus = errSecDuplicateItem;
          return false;
        }
        if (opts?.addWillFail) {
          lastStatus = opts.addErrorCode ?? -1;
          return false;
        }
        store.set(`${service}/${account}`, new Uint8Array(blob));
        lastStatus = 0;
        return true;
      },
      findGenericPassword(service: string, account: string): Uint8Array | null {
        calls.push({ name: "findGenericPassword", service, account });
        if (opts?.findErrorCode != null) {
          lastStatus = opts.findErrorCode;
          return null;
        }
        const v = store.get(`${service}/${account}`);
        if (!v) {
          lastStatus = errSecItemNotFound;
          return null;
        }
        lastStatus = 0;
        return v;
      },
      deleteGenericPassword(service: string, account: string): boolean {
        calls.push({ name: "deleteGenericPassword", service, account });
        if (opts?.deleteWillFail) {
          lastStatus = opts.deleteErrorCode ?? -1;
          return false;
        }
        const had = store.delete(`${service}/${account}`);
        lastStatus = had ? 0 : errSecItemNotFound;
        return had;
      },
      lastStatus(): number {
        calls.push({ name: "lastStatus" });
        return lastStatus;
      },
    },
  };
}

// ---- HEADLINE TEST -------------------------------------------------------

test("MacKeyStore.set never passes the secret as a string parameter (the v1 -w fix)", () => {
  // v1's `security add-generic-password -w <value>` left the secret
  // in argv for a tick — visible to a local `ps`. v0.6.1 closes that
  // window by putting the bytes in the FFI blob parameter and the
  // identifying strings (service / account) in separate string
  // parameters. Pin the separation here so a future regression that
  // accidentally smuggles the value into the account name (or
  // anywhere else string-shaped) gets caught.
  const SECRET = "sk-this-must-only-appear-in-the-blob-not-in-any-string-XXX";
  const { ffi, calls } = recordingFFI();
  const ks = createMacKeyStore({ ffi });
  ks.set("ref-1", SECRET);
  const addCalls = calls.filter((c) => c.name === "addGenericPassword");
  expect(addCalls.length).toBe(1);
  // service + account carry only their documented identifiers,
  // NEVER the value.
  expect((addCalls[0] as any).service).not.toContain(SECRET);
  expect((addCalls[0] as any).account).toBe("ref-1");
  expect((addCalls[0] as any).account).not.toContain(SECRET);
  // The bytes DO live in the blob — exactly where they belong.
  const blob = (addCalls[0] as any).blob as Uint8Array;
  expect(new TextDecoder().decode(blob)).toBe(SECRET);
});

// ---- set ----------------------------------------------------------------

test("MacKeyStore.set uses the configured service name", () => {
  // The test env sets STM_KEYCHAIN_SERVICE=subscribetome-test (see
  // package.json `test` script). All adds should pass that as the
  // service argument.
  const { ffi, calls } = recordingFFI();
  const ks = createMacKeyStore({ ffi });
  ks.set("alpha", "v");
  expect((calls[0] as any).service).toContain("subscribetome");
});

test("MacKeyStore.set throws with the OSStatus on a real failure", () => {
  const { ffi } = recordingFFI({ addWillFail: true, addErrorCode: -25293 });
  const ks = createMacKeyStore({ ffi });
  expect(() => ks.set("x", "v")).toThrow(/OSStatus -25293/);
});

test("MacKeyStore.set encodes the value as UTF-8 bytes", () => {
  const { ffi, calls } = recordingFFI();
  const ks = createMacKeyStore({ ffi });
  ks.set("u8", "héllo-§ÿ-世界");
  const blob = (calls[0] as any).blob as Uint8Array;
  expect(new TextDecoder("utf-8").decode(blob)).toBe("héllo-§ÿ-世界");
});

test("MacKeyStore.set retries delete-then-add on errSecDuplicateItem (upsert behaviour)", () => {
  // v1's `-U` flag did upsert. Our FFI port mirrors that with a
  // delete-then-retry when add reports errSecDuplicateItem.
  const { ffi, calls } = recordingFFI({ addDuplicateThenSucceed: true });
  const ks = createMacKeyStore({ ffi });
  expect(() => ks.set("upsert-target", "new-value")).not.toThrow();
  // Sequence: add (fails dup), delete, add (succeeds).
  const ops = calls
    .filter((c) => c.name !== "lastStatus")
    .map((c) => c.name);
  expect(ops).toEqual([
    "addGenericPassword",
    "deleteGenericPassword",
    "addGenericPassword",
  ]);
});

// ---- get ----------------------------------------------------------------

test("MacKeyStore.get returns the value when present", async () => {
  const { ffi, store } = recordingFFI();
  // Pre-load using whatever the backend will actually pass — read
  // the service name through the same `paths.ts` helper the backend
  // uses, so this stays robust against STM_KEYCHAIN_SERVICE overrides.
  const { keychainService } = await import("../src/paths.ts");
  store.set(`${keychainService()}/r`, new TextEncoder().encode("the-value"));
  const ks = createMacKeyStore({ ffi });
  expect(ks.get("r")).toBe("the-value");
});

test("MacKeyStore.get returns null on errSecItemNotFound (-25300)", () => {
  const { ffi } = recordingFFI();
  const ks = createMacKeyStore({ ffi });
  expect(ks.get("ghost")).toBeNull();
});

test("MacKeyStore.get throws on a non-NotFound failure code", () => {
  // Synthesize "user interaction not allowed" — a real failure mode
  // (-25308). The backend must surface it, not pretend the key is
  // missing.
  const { ffi } = recordingFFI({ findErrorCode: -25308 });
  const ks = createMacKeyStore({ ffi });
  expect(() => ks.get("r")).toThrow(/OSStatus -25308/);
});

test("MacKeyStore round-trips set + get", () => {
  const { ffi } = recordingFFI();
  const ks = createMacKeyStore({ ffi });
  ks.set("rt", "the-secret");
  expect(ks.get("rt")).toBe("the-secret");
});

// ---- delete -------------------------------------------------------------

test("MacKeyStore.delete is idempotent (errSecItemNotFound is OK)", () => {
  const { ffi } = recordingFFI();
  const ks = createMacKeyStore({ ffi });
  expect(() => ks.delete("never-existed")).not.toThrow();
});

test("MacKeyStore.delete throws on a non-NotFound failure code", () => {
  const { ffi } = recordingFFI({
    deleteWillFail: true,
    deleteErrorCode: -25293,
  });
  const ks = createMacKeyStore({ ffi });
  expect(() => ks.delete("anything")).toThrow(/OSStatus -25293/);
});

// ---- describe -----------------------------------------------------------

test("MacKeyStore.describe identifies as `macOS Keychain` (label unchanged from v1)", () => {
  // Lazy FFI: no opts.ffi needed for describe().
  expect(createMacKeyStore().describe()).toBe("macOS Keychain");
});

// ---- isMacKeychainReachable ---------------------------------------------

test("isMacKeychainReachable returns true on a healthy FFI", () => {
  const { ffi } = recordingFFI(); // empty store → probe returns null + -25300
  expect(isMacKeychainReachable({ ffi })).toBe(true);
});

test("isMacKeychainReachable returns false when the FFI throws (framework unloadable)", () => {
  const broken: MacFFI = {
    addGenericPassword: () => { throw new Error("Security.framework missing"); },
    findGenericPassword: () => { throw new Error("Security.framework missing"); },
    deleteGenericPassword: () => { throw new Error("Security.framework missing"); },
    lastStatus: () => 0,
  };
  expect(isMacKeychainReachable({ ffi: broken })).toBe(false);
});

test("isMacKeychainReachable returns false when find returns null with a non-NotFound status", () => {
  // Simulate "user interaction not allowed" — a real failure that
  // shouldn't be confused with "key just absent".
  const { ffi } = recordingFFI({ findErrorCode: -25308 });
  expect(isMacKeychainReachable({ ffi })).toBe(false);
});

// ---- resolver integration -----------------------------------------------

test("selectKeyStore on darwin uses the injected MacFFI when provided", () => {
  const { ffi } = recordingFFI();
  const ks = selectKeyStore({
    force: true,
    platform: "darwin",
    env: {},
    macFFI: ffi,
  });
  expect(ks.describe()).toBe("macOS Keychain");
});

test("STM_KEYSTORE=keychain alias forwards the injected MacFFI", () => {
  const { ffi } = recordingFFI();
  const ks = selectKeyStore({
    force: true,
    platform: "linux", // override beats platform default
    env: { STM_KEYSTORE: "keychain" },
    macFFI: ffi,
  });
  expect(ks.describe()).toBe("macOS Keychain");
});

// ---- Headline reaffirmation across set + get + delete -------------------

test("end-to-end: secret never appears in any string-shaped FFI parameter", () => {
  const SECRET = "sk-still-not-in-any-string-arg-XXXXX";
  const { ffi, calls } = recordingFFI();
  const ks = createMacKeyStore({ ffi });
  ks.set("e2e", SECRET);
  ks.get("e2e");
  ks.delete("e2e");
  // Every string-shaped param (service, account) must not contain
  // the secret. Only the `blob` Uint8Array carries it.
  for (const c of calls) {
    if (c.name === "addGenericPassword" || c.name === "findGenericPassword" || c.name === "deleteGenericPassword") {
      const cc = c as any;
      expect(cc.service).not.toContain(SECRET);
      expect(cc.account).not.toContain(SECRET);
    }
  }
});
