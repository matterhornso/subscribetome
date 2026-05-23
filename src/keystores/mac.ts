// macOS Keychain backend.
//
// Extracted from the v1 src/keychain.ts, behind the KeyStore interface
// from specs/cross-platform-and-codex.md §4.1.
//
// KNOWN LIMITATION carried over from v1: `security add-generic-password -w
// <value>` passes the secret as an argv element, momentarily visible to
// a local `ps` during the write. Acceptable for a single-user local
// tool; called out in README "Limitations". v1.5 will call the Security
// framework directly via Bun FFI to close that window.
import { spawnSync } from "node:child_process";
import { keychainService } from "../paths.ts";
import type { KeyStore, SpawnFn } from "./types.ts";

const SECURITY = "/usr/bin/security";

export function createMacKeyStore(opts?: { spawn?: SpawnFn }): KeyStore {
  const spawn: SpawnFn = opts?.spawn ?? ((cmd, args, o) =>
    spawnSync(cmd, args as string[], { ...o, encoding: o?.encoding ?? "utf8" }) as ReturnType<SpawnFn>);

  return {
    set(ref: string, value: string): void {
      const r = spawn(
        SECURITY,
        ["add-generic-password", "-U", "-s", keychainService(), "-a", ref, "-w", value],
        { encoding: "utf8" },
      );
      if (r.status !== 0) {
        throw new Error(
          `keychain write failed: ${r.stderr?.trim() || `exit ${r.status}`}`,
        );
      }
    },
    get(ref: string): string | null {
      const r = spawn(
        SECURITY,
        ["find-generic-password", "-s", keychainService(), "-a", ref, "-w"],
        { encoding: "utf8" },
      );
      if (r.status !== 0) return null;
      return r.stdout.replace(/\n$/, "");
    },
    delete(ref: string): void {
      spawn(
        SECURITY,
        ["delete-generic-password", "-s", keychainService(), "-a", ref],
        { encoding: "utf8" },
      );
    },
    describe(): string {
      return "macOS Keychain";
    },
  };
}
