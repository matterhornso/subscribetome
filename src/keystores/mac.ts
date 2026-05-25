// macOS Keychain backend.
//
// v0.6.1 closes the v1 argv-exposure window: instead of shelling out
// to `/usr/bin/security add-generic-password -w <value>` (where the
// secret was momentarily visible to a local `ps`), we now call the
// macOS Security framework directly via Bun FFI. The secret bytes
// live in a Uint8Array we own and pass to SecKeychainAddGenericPassword
// by pointer. They never appear as an argv element.
//
// This brings macOS to posture parity with Linux Secret Service
// (stdin pipe, v0.3.1) and Windows Credential Manager (FFI pointer,
// v0.5.0). The Workstream B Windows backend was the worked template.
//
// API surface contract:
//   - createMacKeyStore({ffi?}) returns the KeyStore. Lazy FFI
//     resolution — describe() is callable on any platform without
//     dlopen-ing Security.framework (matters for the dashboard pill
//     on a misconfigured host).
//   - isMacKeychainReachable({ffi?}) probes by trying a find-on-a-
//     known-bogus-name and inspecting the OSStatus. Used by the
//     resolver; never silently falls through to a weaker tier.
//   - realMacFFI() builds the bun:ffi binding lazily. Only reachable
//     on darwin; tests pass opts.ffi to bypass it entirely.

import { dlopen, FFIType, ptr, read, toArrayBuffer, type Pointer } from "bun:ffi";
import { keychainService } from "../paths.ts";
import type { KeyStore, MacFFI } from "./types.ts";

// ---- known OSStatus codes ----
//
// From Security/SecBase.h. We only branch on these two; everything
// else lands in the error message verbatim so a user can grep the
// Apple docs.
const errSecSuccess = 0;
const errSecItemNotFound = -25300;
const errSecDuplicateItem = -25299;

export function createMacKeyStore(opts?: {
  ffi?: MacFFI;
}): KeyStore {
  // Lazy FFI resolution — keeps describe() callable on any host. The
  // Windows backend uses the same pattern; copying it here keeps the
  // two macOS / Windows backends symmetric.
  let _ffi: MacFFI | null = opts?.ffi ?? null;
  const ffi = (): MacFFI => {
    if (_ffi) return _ffi;
    _ffi = realMacFFI();
    return _ffi;
  };

  return {
    set(ref: string, value: string): void {
      const f = ffi();
      const blob = new TextEncoder().encode(value);
      // The Security framework's `Add` fails with `errSecDuplicateItem`
      // when an entry already exists for (service, account). v1's
      // `security -w` used the `-U` flag for upsert behaviour. To
      // mirror that we delete-then-add when we hit the duplicate
      // error. (Doing it the other way — always delete first — would
      // briefly leave the entry absent, which is observably worse
      // for concurrent readers.)
      const okFirstTry = f.addGenericPassword(keychainService(), ref, blob);
      if (okFirstTry) return;
      const status = f.lastStatus();
      if (status === errSecDuplicateItem) {
        f.deleteGenericPassword(keychainService(), ref);
        const okRetry = f.addGenericPassword(keychainService(), ref, blob);
        if (okRetry) return;
        throw new Error(
          `Keychain write failed after delete-and-retry (OSStatus ${f.lastStatus()})`,
        );
      }
      throw new Error(`Keychain write failed (OSStatus ${status})`);
    },
    get(ref: string): string | null {
      const f = ffi();
      const blob = f.findGenericPassword(keychainService(), ref);
      if (blob == null) {
        const status = f.lastStatus();
        if (status === errSecItemNotFound || status === errSecSuccess) {
          return null;
        }
        throw new Error(`Keychain read failed (OSStatus ${status})`);
      }
      return new TextDecoder("utf-8").decode(blob);
    },
    delete(ref: string): void {
      const f = ffi();
      const ok = f.deleteGenericPassword(keychainService(), ref);
      if (!ok && f.lastStatus() !== errSecItemNotFound) {
        throw new Error(`Keychain delete failed (OSStatus ${f.lastStatus()})`);
      }
    },
    describe(): string {
      return "macOS Keychain";
    },
  };
}

/**
 * Resolver probe. The Windows backend's `isWincredReachable` template:
 * call find on a known-bogus account; if the API returns null AND
 * lastStatus is `errSecItemNotFound` (or 0), the API works.
 * Anything else means the framework didn't load, the keychain is
 * locked, or the binding is broken — return false so the resolver
 * hands back `unsupported (...)` with a friendly message rather than
 * silently degrading.
 */
export function isMacKeychainReachable(opts?: { ffi?: MacFFI }): boolean {
  let f: MacFFI;
  try {
    f = opts?.ffi ?? realMacFFI();
  } catch {
    return false;
  }
  try {
    const probe = f.findGenericPassword(
      keychainService(),
      "__stm_probe_does_not_exist__",
    );
    if (probe == null) {
      const status = f.lastStatus();
      return status === errSecItemNotFound || status === errSecSuccess;
    }
    // It would be very surprising to find the probe target — but if
    // we did, the API obviously works.
    return true;
  } catch {
    return false;
  }
}

// ---- Real FFI binding ----
//
// Lazy + cached. Only reached on darwin. Tests inject `opts.ffi`
// directly and never touch this code path.
//
// Function signatures (from `Security/SecKeychain.h` /
// `Security/SecKeychainItem.h`):
//
//   OSStatus SecKeychainAddGenericPassword(
//     SecKeychainRef     keychain,            // NULL = default
//     UInt32             serviceNameLength,
//     const char        *serviceName,
//     UInt32             accountNameLength,
//     const char        *accountName,
//     UInt32             passwordLength,
//     const void        *passwordData,
//     SecKeychainItemRef *itemRef             // NULL OK
//   );
//
//   OSStatus SecKeychainFindGenericPassword(
//     CFTypeRef          keychainOrArray,     // NULL = default
//     UInt32             serviceNameLength,
//     const char        *serviceName,
//     UInt32             accountNameLength,
//     const char        *accountName,
//     UInt32            *passwordLength,      // out
//     void             **passwordData,        // out — SecKeychainItemFreeContent it
//     SecKeychainItemRef *itemRef             // out — used by delete
//   );
//
//   OSStatus SecKeychainItemDelete(SecKeychainItemRef itemRef);
//   OSStatus SecKeychainItemFreeContent(CFArrayRef attrList, void *data);

const SECURITY_FRAMEWORK =
  "/System/Library/Frameworks/Security.framework/Security";

let cachedFFI: MacFFI | null = null;
let cachedStatus = 0;

export function realMacFFI(): MacFFI {
  if (cachedFFI) return cachedFFI;
  if (process.platform !== "darwin") {
    throw new Error(
      `macOS Keychain is only available on darwin; current platform is ` +
        `"${process.platform}". The resolver should not have reached this ` +
        `code path — please file a bug.`,
    );
  }

  const lib = dlopen(SECURITY_FRAMEWORK, {
    SecKeychainAddGenericPassword: {
      args: [
        FFIType.ptr, // keychain  (NULL)
        FFIType.u32, // serviceNameLength
        FFIType.ptr, // serviceName
        FFIType.u32, // accountNameLength
        FFIType.ptr, // accountName
        FFIType.u32, // passwordLength
        FFIType.ptr, // passwordData
        FFIType.ptr, // itemRef out (NULL)
      ],
      returns: FFIType.i32,
    },
    SecKeychainFindGenericPassword: {
      args: [
        FFIType.ptr, // keychainOrArray (NULL)
        FFIType.u32, // serviceNameLength
        FFIType.ptr, // serviceName
        FFIType.u32, // accountNameLength
        FFIType.ptr, // accountName
        FFIType.ptr, // passwordLength out
        FFIType.ptr, // passwordData out
        FFIType.ptr, // itemRef out
      ],
      returns: FFIType.i32,
    },
    SecKeychainItemDelete: {
      args: [FFIType.ptr],
      returns: FFIType.i32,
    },
    SecKeychainItemFreeContent: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  });

  cachedFFI = {
    addGenericPassword(service: string, account: string, blob: Uint8Array): boolean {
      const svc = new TextEncoder().encode(service);
      const acc = new TextEncoder().encode(account);
      const status = Number(
        lib.symbols.SecKeychainAddGenericPassword(
          null,
          svc.byteLength,
          ptr(svc),
          acc.byteLength,
          ptr(acc),
          blob.byteLength,
          ptr(blob),
          null,
        ),
      );
      cachedStatus = status;
      return status === errSecSuccess;
    },
    findGenericPassword(service: string, account: string): Uint8Array | null {
      const svc = new TextEncoder().encode(service);
      const acc = new TextEncoder().encode(account);
      // Two out-params: passwordLength (u32) and passwordData (void**).
      // We pack them into Uint8Arrays we own; the framework writes
      // through the pointers we pass.
      const outLen = new Uint8Array(4); // sizeof(UInt32)
      const outData = new Uint8Array(8); // sizeof(void*)
      // itemRef out — we don't actually need it for find-only ops,
      // but the call expects a non-null sink when the caller may
      // free the item later. For pure read we pass null.
      const status = Number(
        lib.symbols.SecKeychainFindGenericPassword(
          null,
          svc.byteLength,
          ptr(svc),
          acc.byteLength,
          ptr(acc),
          ptr(outLen),
          ptr(outData),
          null,
        ),
      );
      cachedStatus = status;
      if (status !== errSecSuccess) return null;
      const len = new DataView(outLen.buffer).getUint32(0, true);
      if (len === 0) return new Uint8Array(0);
      const dataPtr = readPointer(outData);
      if (!dataPtr) return null;
      // Copy the bytes out BEFORE freeing — toArrayBuffer hands us a
      // view over OS-owned memory that becomes invalid after
      // SecKeychainItemFreeContent.
      const view = new Uint8Array(toArrayBuffer(dataPtr, 0, len));
      const out = new Uint8Array(view); // copy
      lib.symbols.SecKeychainItemFreeContent(null, dataPtr);
      return out;
    },
    deleteGenericPassword(service: string, account: string): boolean {
      // Delete = find + SecKeychainItemDelete on the returned itemRef.
      // We use a second binding shape that captures itemRef so we
      // can free the entry instead of just its password buffer.
      const svc = new TextEncoder().encode(service);
      const acc = new TextEncoder().encode(account);
      const outItem = new Uint8Array(8);
      const status = Number(
        lib.symbols.SecKeychainFindGenericPassword(
          null,
          svc.byteLength,
          ptr(svc),
          acc.byteLength,
          ptr(acc),
          null, // we don't need the length
          null, // we don't need the data
          ptr(outItem),
        ),
      );
      cachedStatus = status;
      if (status === errSecItemNotFound) return false;
      if (status !== errSecSuccess) return false;
      const itemPtr = readPointer(outItem);
      if (!itemPtr) return false;
      const delStatus = Number(lib.symbols.SecKeychainItemDelete(itemPtr));
      cachedStatus = delStatus;
      // ItemFreeContent(NULL, item) doesn't free the item itself —
      // we'd use CFRelease for that. The OS reclaims the ref when
      // our process exits; for a single delete this is fine.
      return delStatus === errSecSuccess;
    },
    lastStatus(): number {
      return cachedStatus;
    },
  };
  return cachedFFI;
}

// ---- pointer helpers ----

function readPointer(slot: Uint8Array): Pointer | null {
  const view = new DataView(slot.buffer, slot.byteOffset, slot.byteLength);
  const raw = view.getBigUint64(0, true);
  if (raw === 0n) return null;
  return Number(raw) as unknown as Pointer;
}

// `read` is currently unused — kept imported so future helpers
// can walk OS-owned structs without re-importing. Suppress the
// linter complaint via a no-op reference.
void read;
