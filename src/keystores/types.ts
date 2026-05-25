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
