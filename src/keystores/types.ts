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
