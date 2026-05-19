// macOS Keychain wrapper.
//
// v1 is darwin-only — the founder's machine. Linux/Windows keychain backends
// are deferred (see README "Limitations").
//
// Known limitation: `security` receives the secret as an argv element, so it
// is momentarily visible to a local `ps` during the write. Acceptable for a
// single-user local tool; v1.5 should call the Security framework directly
// (Bun FFI) to close that window.
import { spawnSync } from "node:child_process";
import { keychainService } from "./paths.ts";

const SECURITY = "/usr/bin/security";

/** Store (or update) a secret under an opaque ref. Throws on failure. */
export function keychainSet(ref: string, value: string): void {
  const r = spawnSync(
    SECURITY,
    ["add-generic-password", "-U", "-s", keychainService(), "-a", ref, "-w", value],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(`keychain write failed: ${r.stderr?.trim() || `exit ${r.status}`}`);
  }
}

/** Fetch a secret by ref, or null if absent. */
export function keychainGet(ref: string): string | null {
  const r = spawnSync(
    SECURITY,
    ["find-generic-password", "-s", keychainService(), "-a", ref, "-w"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  // `security -w` prints the value followed by a newline.
  return r.stdout.replace(/\n$/, "");
}

/** Delete a secret by ref. Silent if absent. */
export function keychainDelete(ref: string): void {
  spawnSync(
    SECURITY,
    ["delete-generic-password", "-s", keychainService(), "-a", ref],
    { encoding: "utf8" },
  );
}
