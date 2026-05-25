// Windows Credential Manager backend (specs/cross-platform-and-codex.md §5
// Windows row; build plan: specs/plans/v0.5-windows-backend.md).
//
// Storage: per-user, DPAPI-encrypted blob in Credential Manager.
// Target-name namespace: `Subscribetome:<ref>` so the control-panel
// UI and `cmdkey /list` group our entries.
//
// WHY FFI, NOT A CLI:
//   - `cmdkey` (built-in) can write + delete but CANNOT read a
//     password back. Useless for the `get` half of KeyStore.
//   - `wincred` is the only documented surface that supports read.
//     It is a Win32 API, not a CLI.
//   - `keytar` (npm) is archived 2026-03.
//
// So this backend talks to advapi32.dll directly via bun:ffi.
//
// POSTURE — STRICT IMPROVEMENT OVER MACOS:
//   On macOS the v1 backend shells out to `security add-generic-
//   password -w <value>`, momentarily exposing the secret to a local
//   `ps`. Linux Secret Service (v0.3.1) closed that hole by piping the
//   secret via stdin. Windows closes it more cleanly still: the secret
//   bytes live in a Uint8Array we own and pass to CredWriteW by
//   pointer. There is no argv element, no fd, no environment variable
//   in play — the bytes go directly into CREDENTIALW.CredentialBlob.
//   This is the load-bearing reason for the FFI approach.
//
// TESTABILITY:
//   The backend takes a `WincredFFI` so tests inject a recording fake.
//   The real bun:ffi binding is built lazily by `realWincredFFI()`
//   below — it is the ONE place that touches advapi32, and it is only
//   reached on `process.platform === "win32"` during resolution.

import {
  dlopen,
  FFIType,
  ptr,
  read,
  suffix,
  toArrayBuffer,
  type Pointer,
} from "bun:ffi";
import type { KeyStore, WincredFFI } from "./types.ts";

/** Win32 error codes we care about. The rest land in the error message. */
const ERROR_NOT_FOUND = 1168;

/** CRED_TYPE_GENERIC — for stm we never write certificate / domain creds. */
const CRED_TYPE_GENERIC = 1;
/** CRED_PERSIST_LOCAL_MACHINE = 2; survives reboots, scoped to this account. */
const CRED_PERSIST_LOCAL_MACHINE = 2;

/** Namespace prefix on Credential Manager target names. */
const TARGET_PREFIX = "Subscribetome:";

function targetFor(ref: string): string {
  return TARGET_PREFIX + ref;
}

export function createWindowsCredentialKeyStore(opts?: {
  ffi?: WincredFFI;
}): KeyStore {
  // Lazy FFI resolution — `realWincredFFI()` throws on non-Windows
  // hosts, but `describe()` is callable from anywhere (tests, the
  // dashboard pill on a macOS dev daemon listing what the override
  // would produce). Constructing the backend must never throw; only
  // the op-level methods that actually need the FFI do.
  let _ffi: WincredFFI | null = opts?.ffi ?? null;
  const ffi = (): WincredFFI => {
    if (_ffi) return _ffi;
    _ffi = realWincredFFI();
    return _ffi;
  };

  return {
    set(ref: string, value: string): void {
      const f = ffi();
      // The secret bytes go straight into CREDENTIALW.CredentialBlob
      // via the FFI. They do NOT pass through argv, stdin, or any
      // environment variable. This is the load-bearing posture
      // upgrade over the macOS backend.
      const blob = new TextEncoder().encode(value);
      const ok = f.credWriteW(targetFor(ref), blob);
      if (!ok) {
        const code = f.lastError();
        throw new Error(
          `Windows Credential Manager write failed (Win32 error ${code}). ` +
            `Common causes: locked user profile, restricted sandbox, or ` +
            `Credential Manager service disabled.`,
        );
      }
    },
    get(ref: string): string | null {
      const f = ffi();
      const blob = f.credReadW(targetFor(ref));
      if (blob == null) {
        // Distinguish "absent" from "broken". The resolver's probe
        // already weeded out "broken" — here, null is just absent.
        if (f.lastError() === ERROR_NOT_FOUND || f.lastError() === 0) {
          return null;
        }
        // Anything else is a real failure that should bubble up.
        throw new Error(
          `Windows Credential Manager read failed (Win32 error ${f.lastError()})`,
        );
      }
      return new TextDecoder("utf-8").decode(blob);
    },
    delete(ref: string): void {
      const f = ffi();
      // Idempotent — ERROR_NOT_FOUND is "fine, already gone", matching
      // the Linux backend's `secret-tool clear` convention.
      const ok = f.credDeleteW(targetFor(ref));
      if (!ok) {
        const code = f.lastError();
        if (code === ERROR_NOT_FOUND) return;
        throw new Error(
          `Windows Credential Manager delete failed (Win32 error ${code})`,
        );
      }
    },
    describe(): string {
      return "Windows Credential Manager (DPAPI)";
    },
  };
}

/**
 * Resolver probe — used during autodetection to decide whether the
 * Windows backend is actually usable on this host. The cheapest
 * possible check: read a credential we know does not exist and
 * inspect the error code.
 *
 *   - ERROR_NOT_FOUND (1168) → API is loaded + working; the target
 *     is genuinely absent. Return true.
 *   - 0 with `null` → also a clean "absent" response from the FFI
 *     surface; return true.
 *   - Anything else → advapi32 won't load, sandbox blocks the call,
 *     or service is disabled. Return false; the resolver hands back
 *     `unsupported (...)` with a friendly message rather than
 *     silently falling through to a weaker tier.
 */
export function isWincredReachable(opts?: { ffi?: WincredFFI }): boolean {
  let ffi: WincredFFI;
  try {
    ffi = opts?.ffi ?? realWincredFFI();
  } catch {
    return false;
  }
  try {
    const probe = ffi.credReadW(targetFor("__stm_probe_does_not_exist__"));
    if (probe == null) {
      const code = ffi.lastError();
      return code === ERROR_NOT_FOUND || code === 0;
    }
    // It would be very surprising to find our probe target — but if
    // we DID, the API obviously works.
    return true;
  } catch {
    return false;
  }
}

// ---- Real FFI binding ----------------------------------------------------
//
// Built lazily because dlopen("advapi32") obviously fails on macOS /
// Linux. The resolver only reaches `realWincredFFI()` on
// `process.platform === "win32"`, AND tests inject `opts.ffi`
// directly, so this code path is unreachable in CI on dev machines.
//
// `CREDENTIALW` struct layout (Win32 public ABI, stable since Windows
// 2000 — documented at learn.microsoft.com/en-us/windows/win32/api/
// wincred/ns-wincred-credentialw):
//
//   typedef struct _CREDENTIALW {
//     DWORD                 Flags;               //   0..4
//     DWORD                 Type;                //   4..8
//     LPWSTR                TargetName;          //   8..16
//     LPWSTR                Comment;             //  16..24
//     FILETIME              LastWritten;         //  24..32
//     DWORD                 CredentialBlobSize;  //  32..36
//     LPBYTE                CredentialBlob;      //  40..48  (8-aligned)
//     DWORD                 Persist;             //  48..52
//     DWORD                 AttributeCount;      //  52..56
//     PCREDENTIAL_ATTRIBUTEW Attributes;         //  56..64
//     LPWSTR                TargetAlias;         //  64..72
//     LPWSTR                UserName;            //  72..80
//   } CREDENTIALW;                                // 80 bytes total
//
// 64-bit Windows uses natural alignment; all pointer fields are
// 8-byte aligned. Total size 80 bytes.

const CREDENTIALW_SIZE = 80;
// Offsets inside the struct.
const OFF_FLAGS = 0;
const OFF_TYPE = 4;
const OFF_TARGET_NAME = 8;
const OFF_BLOB_SIZE = 32;
const OFF_BLOB = 40;
const OFF_PERSIST = 48;
const OFF_USER_NAME = 72;

/** Encode a JS string as a NUL-terminated UTF-16LE buffer (LPWSTR). */
function wstr(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length * 2 + 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < s.length; i++) {
    view.setUint16(i * 2, s.charCodeAt(i), true);
  }
  // trailing NUL is the +2 above; new Uint8Array zero-initializes.
  return bytes;
}

/** Decode a NUL-terminated UTF-16LE buffer back to a JS string. */
function unwstr(bytes: Uint8Array): string {
  // Bytes carry the secret value — no chr-set tricks needed here, but
  // we strip the trailing NUL pair if present.
  let len = bytes.length;
  if (len >= 2 && bytes[len - 1] === 0 && bytes[len - 2] === 0) {
    len -= 2;
  }
  let out = "";
  const view = new DataView(bytes.buffer, bytes.byteOffset, len);
  for (let i = 0; i < len; i += 2) {
    out += String.fromCharCode(view.getUint16(i, true));
  }
  return out;
}

let cachedFFI: WincredFFI | null = null;

/**
 * Build (or return the cached) real advapi32 binding. Throws on any
 * platform that can't dlopen advapi32 — callers use try/catch and
 * fall back to the `unsupported` keystore so we never silently lose
 * the user's secret.
 *
 * In practice this is only ever called when `process.platform ===
 * "win32"`. Tests bypass it entirely via `opts.ffi`.
 */
export function realWincredFFI(): WincredFFI {
  if (cachedFFI) return cachedFFI;

  if (process.platform !== "win32") {
    throw new Error(
      `Windows Credential Manager is only available on Windows; current ` +
        `platform is "${process.platform}". The resolver should not have ` +
        `reached this code path — please file a bug.`,
    );
  }

  // advapi32.dll lives in System32 on every Windows install since NT 4.
  // `suffix` is `dll` on win32, so `advapi32.${suffix}` is the lookup
  // string bun:ffi expects.
  const lib = dlopen(`advapi32.${suffix}`, {
    CredWriteW: {
      args: [FFIType.ptr, FFIType.u32],
      returns: FFIType.bool,
    },
    CredReadW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.bool,
    },
    CredDeleteW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32],
      returns: FFIType.bool,
    },
    CredFree: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
  });

  // Kernel32 holds GetLastError. We dlopen it separately so the call
  // stays explicit at every error site.
  const kernel32 = dlopen(`kernel32.${suffix}`, {
    GetLastError: {
      args: [],
      returns: FFIType.u32,
    },
  });

  cachedFFI = {
    credWriteW(targetName: string, blob: Uint8Array): boolean {
      // Build CREDENTIALW in-process so the secret bytes live ONLY in
      // a Uint8Array we own. The struct points at our buffers; no
      // copy is required.
      const cred = new Uint8Array(CREDENTIALW_SIZE);
      const view = new DataView(cred.buffer);
      const target = wstr(targetName);
      // Persist as the user — every reachable call site is the user.
      const userName = wstr("subscribetome");

      view.setUint32(OFF_FLAGS, 0, true);
      view.setUint32(OFF_TYPE, CRED_TYPE_GENERIC, true);
      writePtr(view, OFF_TARGET_NAME, target);
      view.setUint32(OFF_BLOB_SIZE, blob.byteLength, true);
      writePtr(view, OFF_BLOB, blob);
      view.setUint32(OFF_PERSIST, CRED_PERSIST_LOCAL_MACHINE, true);
      writePtr(view, OFF_USER_NAME, userName);

      return Boolean(lib.symbols.CredWriteW(ptr(cred), 0));
    },
    credReadW(targetName: string): Uint8Array | null {
      const target = wstr(targetName);
      // The OS allocates the CREDENTIALW for us; we get back a
      // pointer-to-pointer. Reading the size + blob then `CredFree`-ing
      // the result.
      const outPtr = new Uint8Array(8); // pointer slot
      const ok = lib.symbols.CredReadW(
        ptr(target),
        CRED_TYPE_GENERIC,
        0,
        ptr(outPtr),
      );
      if (!ok) return null;
      // Dereference outPtr to a CREDENTIALW pointer, then read its
      // BlobSize + Blob fields. This is the trickiest part of the
      // binding — we use bun:ffi's `read` helpers to walk the
      // pointers without copying intermediate bytes through JS strings.
      const credPtr = readPointer(outPtr);
      if (!credPtr) return null;
      // bun:ffi's `read.u32` / `read.ptr` walk the OS-owned struct
      // without copying — much cheaper than `toArrayBuffer` for the
      // whole CREDENTIALW.
      const blobSize = read.u32(credPtr, OFF_BLOB_SIZE);
      const blobPtr = read.ptr(credPtr, OFF_BLOB) as unknown as Pointer;
      const out = readBytes(blobPtr, blobSize);
      // Hand the allocation back to the OS so we don't leak.
      lib.symbols.CredFree(credPtr);
      return out;
    },
    credDeleteW(targetName: string): boolean {
      const target = wstr(targetName);
      return Boolean(
        lib.symbols.CredDeleteW(ptr(target), CRED_TYPE_GENERIC, 0),
      );
    },
    lastError(): number {
      return Number(kernel32.symbols.GetLastError());
    },
  };
  return cachedFFI;
}

// ---- Pointer helpers ----
//
// These are isolated below the `realWincredFFI` body because they are
// only reached when bun:ffi successfully loaded advapi32 — i.e. only
// on Windows. They use Bun's `read` helpers (off the bun:ffi import
// surface). If those helpers move or the binding API changes, only
// these three functions need to follow.

function writePtr(view: DataView, offset: number, buf: Uint8Array): void {
  // 64-bit little-endian pointer to the buffer's backing memory.
  view.setBigUint64(offset, BigInt(ptr(buf) as unknown as number), true);
}

function readPointer(slot: Uint8Array): Pointer | null {
  const view = new DataView(slot.buffer, slot.byteOffset, slot.byteLength);
  const raw = view.getBigUint64(0, true);
  if (raw === 0n) return null;
  return Number(raw) as unknown as Pointer;
}

function readBytes(base: Pointer | null, len: number): Uint8Array {
  if (!base || len === 0) return new Uint8Array(0);
  // `toArrayBuffer(ptr, byteOffset, byteLength)` returns a no-copy
  // JS view over the OS-owned buffer. We immediately copy into a
  // fresh Uint8Array because the OS will reclaim that memory on
  // CredFree.
  const view = new Uint8Array(toArrayBuffer(base, 0, len));
  return new Uint8Array(view);
}
