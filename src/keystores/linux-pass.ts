// Linux Pass backend — Tier 2 of the Linux fallback chain
// (specs/cross-platform-and-codex.md §5; plan: specs/plans/v0.6-linux-headless.md).
//
// `pass(1)` is a shell script over `gpg`. Each secret is one file
// under $PASSWORD_STORE_DIR (default ~/.password-store/), encrypted to
// the user's GPG key. It's the de facto standard headless secret
// manager on Linux: GPG-backed (the agent the user already runs),
// works over SSH with agent forwarding, in every distro's repos.
//
// Why this is Tier 2, not Tier 1:
//   - Requires the user to set up a GPG key and run `pass init`. Not
//     present on a fresh box.
//   - Tier 1 (LinuxSecretService) is the desktop standard. On a
//     headless box, libsecret usually has no daemon to talk to, so
//     Tier 1 fails the probe and we fall through to here.
//
// POSTURE — STRICT IMPROVEMENT OVER MACOS, SAME AS LINUX-SS:
//   - `set` writes via stdin (`pass insert --multiline`), so the
//     secret never appears as an argv element. macOS v1's `-w
//     <value>` exposure is closed here too.
//   - `get` reads stdout; trailing newline stripped exactly like the
//     SecretService backend.
//   - `delete` is `pass rm -f` — idempotent, no prompt.

import { spawnSync } from "node:child_process";
import type { KeyStore, SpawnFn } from "./types.ts";

const PASS = "pass";

/**
 * Namespace prefix on `pass` entry names. With `pass`, the prefix
 * becomes a directory under `~/.password-store/subscribetome/` — so
 * `pass ls subscribetome` lists exactly stm's entries and nothing
 * else. Mirrors the `service` attribute on the libsecret backend.
 */
const NAMESPACE = "subscribetome";

function passPath(ref: string): string {
  return `${NAMESPACE}/${ref}`;
}

export function createLinuxPassKeyStore(opts?: {
  spawn?: SpawnFn;
}): KeyStore {
  const spawn: SpawnFn = opts?.spawn ?? ((cmd, args, o) =>
    spawnSync(cmd, args as string[], { ...o, encoding: o?.encoding ?? "utf8" }) as ReturnType<SpawnFn>);

  return {
    set(ref: string, value: string): void {
      // `pass insert --multiline` reads from stdin until EOF; the
      // secret is the entire stdin content. `-f` overwrites if the
      // entry exists. This is the load-bearing posture detail: the
      // value goes via stdin, NEVER argv.
      const r = spawn(
        PASS,
        ["insert", "--multiline", "-f", passPath(ref)],
        { input: value, encoding: "utf8" },
      );
      if (r.status !== 0) {
        throw new Error(
          `pass write failed: ${r.stderr?.trim() || `exit ${r.status}`}`,
        );
      }
    },
    get(ref: string): string | null {
      // `pass show <path>` writes the secret bytes to stdout. On a
      // missing entry it exits non-zero and prints "Error: ... is
      // not in the password store." — return null to match the
      // KeyStore contract.
      const r = spawn(
        PASS,
        ["show", passPath(ref)],
        { encoding: "utf8" },
      );
      if (r.status !== 0) return null;
      return r.stdout.replace(/\n$/, "");
    },
    delete(ref: string): void {
      // `-f` makes the removal non-interactive AND idempotent on a
      // missing entry. Mirrors the Linux SS backend's `clear`.
      spawn(
        PASS,
        ["rm", "-f", passPath(ref)],
        { encoding: "utf8" },
      );
    },
    describe(): string {
      return "Linux Pass (pass + GPG)";
    },
  };
}

/**
 * Cheap probe for Tier 2 health. We require BOTH:
 *   1. `pass` on PATH (exit code 0 from `pass version`).
 *   2. A usable password store — `pass ls` either lists entries
 *      (exit 0) or reports "Password store is empty" (exit 0). It
 *      exits non-zero when there's no `.gpg-id` file (store never
 *      initialised) or when the GPG key is missing.
 *
 * Returns false on either failure — the resolver falls through to
 * Tier 3 (or unsupported) and `stm doctor` tells the user exactly
 * what to fix.
 */
export function probeLinuxPass(opts?: { spawn?: SpawnFn }): boolean {
  const spawn: SpawnFn = opts?.spawn ?? ((cmd, args, o) =>
    spawnSync(cmd, args as string[], { ...o, encoding: o?.encoding ?? "utf8" }) as ReturnType<SpawnFn>);
  try {
    const v = spawn(PASS, ["version"], { encoding: "utf8" });
    if (v.status !== 0) return false;
    // `pass ls` checks the store is initialised AND the GPG agent
    // can be reached. If GPG fails (no key, locked agent), this
    // surfaces the failure cleanly.
    const ls = spawn(PASS, ["ls"], { encoding: "utf8" });
    return ls.status === 0;
  } catch {
    return false;
  }
}
