// Keychain shim — the public surface the rest of stm has always used.
//
// v0.3.1 (cross-platform-and-codex.md §4.1) splits the implementation
// into pluggable per-OS backends under `src/keystores/`. This file
// stays thin so existing callers (store.ts, hooks.ts, daemon.ts, the
// audit tests, …) don't need to know the resolution happens. They
// still call `keychainSet/Get/Delete`; we delegate.
//
// The resolved backend is exposed via `activeKeyStore()` so `stm
// status` and the dashboard can tell the user where keys actually
// live ("macOS Keychain", "Linux Secret Service (libsecret)", …) —
// the spec mandates the active backend never be hidden.
import { getKeyStore } from "./keystores/index.ts";
import type { KeyStore } from "./keystores/index.ts";

/** Store (or update) a secret under an opaque ref. Throws on failure. */
export function keychainSet(ref: string, value: string): void {
  getKeyStore().set(ref, value);
}

/** Fetch a secret by ref, or null if absent. */
export function keychainGet(ref: string): string | null {
  return getKeyStore().get(ref);
}

/** Delete a secret by ref. Silent if absent. */
export function keychainDelete(ref: string): void {
  getKeyStore().delete(ref);
}

/**
 * The resolved KeyStore — used by `stm status` and the dashboard to
 * surface the active backend's human label. Distinct from the three
 * functions above so callers that just want to do CRUD don't pull in
 * the typed shape.
 */
export function activeKeyStore(): KeyStore {
  return getKeyStore();
}
