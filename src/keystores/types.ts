// KeyStore interface (specs/cross-platform-and-codex.md §4.1).
//
// Every key-storage backend implements this surface. The Store and the
// hook layer call only through this — they never touch a backend
// directly. New OS support = one new module in this directory.
//
// Implementation rules (load-bearing):
//   - `set` must NOT pass the secret as an argv element. The spec calls
//     out the macOS limitation; new backends must do better, not worse.
//     Pass secrets via stdin where the underlying tool supports it.
//   - `get` returns null for "not found" — never an empty string and
//     never a thrown error in the happy path. Throws only on backend
//     misuse (binary missing, permission denied, corrupt store).
//   - `delete` is idempotent. Silent on "already gone".
//   - `describe()` is shown to the user verbatim ("macOS Keychain",
//     "Linux Secret Service (libsecret)", …). The spec mandates the
//     active backend never be hidden from the user.

export interface KeyStore {
  set(ref: string, value: string): void;
  get(ref: string): string | null;
  delete(ref: string): void;
  /** Human label for the dashboard, `stm status`, and error messages. */
  describe(): string;
}

/**
 * The thin part of `spawnSync` that backends actually need. Lifted to
 * an interface so unit tests can inject a synchronous fake without
 * touching the real OS.
 */
export interface SpawnFn {
  (
    command: string,
    args: readonly string[],
    options?: { input?: string; encoding?: BufferEncoding },
  ): {
    status: number | null;
    stdout: string;
    stderr: string;
  };
}

/**
 * A simple "is this binary on $PATH" check. Backends use it during
 * autodetection. Implemented in `index.ts` so tests can stub it.
 */
export interface WhichFn {
  (binary: string): boolean;
}

/**
 * The thin surface the macOS backend needs from the Security
 * framework. Lifted so tests inject a fake — we can exercise the
 * KeyStore without writing into the real Keychain on a dev machine.
 *
 * The real implementation in `src/keystores/mac.ts` dlopens
 * `/System/Library/Frameworks/Security.framework/Security` and binds
 * four entry points:
 *   - SecKeychainAddGenericPassword   (write)
 *   - SecKeychainFindGenericPassword  (read; out-param + ItemFreeContent)
 *   - SecKeychainItemDelete           (delete; chained after find)
 *   - SecKeychainItemFreeContent      (release the read buffer)
 *
 * Why FFI instead of `/usr/bin/security`:
 *   The v1 backend ran `security add-generic-password -w <value>`,
 *   leaving the secret briefly visible to a local `ps` during the
 *   write. v0.3.1 closed that hole on Linux (stdin pipe) and v0.5.0
 *   closed it on Windows (FFI pointer). This release closes it on
 *   macOS too — the secret bytes live in a Uint8Array we own and
 *   pass to SecKeychainAddGenericPassword by pointer. No argv, no
 *   stdin, no env in play.
 *
 * Each method's contract:
 *   - `addGenericPassword(service, account, blob)` writes (or
 *     replaces, via the "exists → delete then add" idiom we
 *     implement in mac.ts) a generic-password item. Returns true on
 *     OSStatus 0.
 *   - `findGenericPassword(service, account)` returns the password
 *     bytes, or null on errSecItemNotFound. The implementation must
 *     call SecKeychainItemFreeContent on the OS-allocated buffer
 *     before returning.
 *   - `deleteGenericPassword(service, account)` returns true on
 *     success; idempotent — errSecItemNotFound returns true too.
 *   - `lastStatus()` is the most-recent OSStatus, used to
 *     distinguish "not found" from a real failure during the probe.
 */
export interface MacFFI {
  addGenericPassword(service: string, account: string, blob: Uint8Array): boolean;
  findGenericPassword(service: string, account: string): Uint8Array | null;
  deleteGenericPassword(service: string, account: string): boolean;
  lastStatus(): number;
}

/**
 * The thin surface a Windows backend needs from the Win32 credential
 * API. Lifted so tests inject a fake — Bun FFI on macOS dev machines
 * has no advapi32 to dlopen, and even on Windows we don't want to
 * touch the real Credential Manager from a test.
 *
 * Each method's contract:
 *   - `credWriteW(target, blob)` writes a generic credential under
 *     `target`. Returns true on success. `blob` is the raw secret
 *     bytes — the FFI implementation pushes them into the
 *     `CREDENTIALW.CredentialBlob` field directly. NEVER stringified
 *     into argv (the spec's load-bearing posture rule).
 *   - `credReadW(target)` returns the credential bytes, or null when
 *     the target is missing (Windows ERROR_NOT_FOUND).
 *   - `credDeleteW(target)` returns true on success; idempotent —
 *     missing target returns true too (Linux backend's `clear`
 *     convention).
 *   - `lastError()` is the most-recent Win32 error code. Used to
 *     distinguish "not found" from "advapi32 unloadable" during
 *     the reachability probe.
 *
 * The real implementation is built lazily in
 * `src/keystores/windows-credential.ts` via `bun:ffi` against
 * advapi32.dll. The factory there returns this same interface, so
 * the backend code is identical between real + test mode.
 */
export interface WincredFFI {
  credWriteW(targetName: string, blob: Uint8Array): boolean;
  credReadW(targetName: string): Uint8Array | null;
  credDeleteW(targetName: string): boolean;
  lastError(): number;
}
