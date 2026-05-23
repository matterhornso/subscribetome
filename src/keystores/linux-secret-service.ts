// Linux Secret Service backend (specs/cross-platform-and-codex.md §5).
//
// Uses `secret-tool` (libsecret's CLI) to talk to whichever daemon is
// implementing the freedesktop.org Secret Service spec on this host —
// usually `gnome-keyring-daemon` on GNOME-based desktops, `kwallet`
// with the secret-service compatibility shim on KDE.
//
// Why secret-tool and not a direct D-Bus call:
//   - It is the documented portable CLI. The D-Bus surface is
//     well-defined but binding it from a Bun process means another
//     dependency. The CLI is a one-line install on every major
//     distro (`apt install libsecret-tools`, `dnf install libsecret`,
//     `pacman -S libsecret`).
//   - secret-tool reads the secret from stdin in `store` mode, so
//     unlike the macOS `security` shim the secret never lives in an
//     argv element. This is strictly better than v1's posture.
//
// Failure modes that bubble back to the resolver as `null` from the
// presence check:
//   - secret-tool not on PATH (user hasn't installed libsecret).
//   - No D-Bus session bus (headless SSH, container, WSL) —
//     `Cannot autolaunch D-Bus without X11 $DISPLAY` kind of error.
// In both cases the resolver falls through to the next tier per §5 of
// the spec.

import { spawnSync } from "node:child_process";
import type { KeyStore, SpawnFn } from "./types.ts";

const SECRET_TOOL = "secret-tool";

/** Attribute name we tag every entry with, namespacing stm's items. */
const ATTR_SERVICE = "service";
/** Attribute name carrying the opaque keychain_ref. */
const ATTR_KEY = "key";
/** Constant attribute value for the service. */
const SERVICE_LABEL = "subscribetome";

/**
 * Default exit-code surface from secret-tool:
 *   0  — success
 *   1  — generic error / not found in `lookup`
 *   127 — `secret-tool` itself missing from PATH (caller layer)
 */
export function createLinuxSecretServiceKeyStore(opts?: {
  spawn?: SpawnFn;
}): KeyStore {
  const spawn: SpawnFn = opts?.spawn ?? ((cmd, args, o) =>
    spawnSync(cmd, args as string[], { ...o, encoding: o?.encoding ?? "utf8" }) as ReturnType<SpawnFn>);

  return {
    set(ref: string, value: string): void {
      // `secret-tool store` reads the secret from stdin. This is the
      // load-bearing posture upgrade over the macOS backend: the secret
      // never appears in argv.
      const r = spawn(
        SECRET_TOOL,
        [
          "store",
          "--label=subscribetome",
          ATTR_SERVICE, SERVICE_LABEL,
          ATTR_KEY, ref,
        ],
        { input: value, encoding: "utf8" },
      );
      if (r.status !== 0) {
        throw new Error(
          `Linux Secret Service write failed: ${r.stderr?.trim() || `exit ${r.status}`}`,
        );
      }
    },
    get(ref: string): string | null {
      const r = spawn(
        SECRET_TOOL,
        ["lookup", ATTR_SERVICE, SERVICE_LABEL, ATTR_KEY, ref],
        { encoding: "utf8" },
      );
      if (r.status !== 0) return null;
      // `secret-tool lookup` writes the value followed by a newline
      // when the entry exists. Strip exactly one trailing newline so
      // values that legitimately end with whitespace survive.
      return r.stdout.replace(/\n$/, "");
    },
    delete(ref: string): void {
      // `clear` exits 0 even when no matching item exists (it is
      // delete-by-attributes, not by id). Idempotent by design.
      spawn(
        SECRET_TOOL,
        ["clear", ATTR_SERVICE, SERVICE_LABEL, ATTR_KEY, ref],
        { encoding: "utf8" },
      );
    },
    describe(): string {
      return "Linux Secret Service (libsecret)";
    },
  };
}

/**
 * Cheap one-shot probe used during resolver autodetection. Returns true
 * when secret-tool is callable AND can reach a session bus — i.e. when
 * the backend is actually usable, not just installed. The probe runs
 * `secret-tool search` against an attribute we know won't match, which
 * is a no-op on a working backend and fails fast on a broken one.
 *
 * Kept lean so the dashboard's `stm status` doesn't pay for it on
 * macOS.
 */
export function probeLinuxSecretService(opts?: { spawn?: SpawnFn }): boolean {
  const spawn: SpawnFn = opts?.spawn ?? ((cmd, args, o) =>
    spawnSync(cmd, args as string[], { ...o, encoding: o?.encoding ?? "utf8" }) as ReturnType<SpawnFn>);
  try {
    const r = spawn(
      SECRET_TOOL,
      ["search", ATTR_SERVICE, SERVICE_LABEL, ATTR_KEY, "__stm_probe_does_not_exist__"],
      { encoding: "utf8" },
    );
    // exit 0 = found (won't happen), exit 1 = not found (ok), anything
    // else (no D-Bus, no keyring daemon, missing binary) = bad probe.
    return r.status === 0 || r.status === 1;
  } catch {
    return false;
  }
}
