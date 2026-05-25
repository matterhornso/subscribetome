// `stm doctor` — keystore tier diagnosis (specs/plans/v0.6-linux-headless.md §4.4).
//
// The CLI prints what comes out of this module. We keep it as a pure
// function returning structured data so the dashboard can also call
// it (a future surface) and so tests don't have to parse stdout.
//
// What it reports per platform:
//   - macOS    : one tier (Keychain). Either OK or unsupported.
//   - Windows  : one tier (Credential Manager). Either OK or unsupported.
//   - Linux    : THREE tiers. Each tier reports reachable / not
//                reachable + a concrete fix line. The first reachable
//                tier is marked "(active)".
//
// `stm doctor` exits 0 when the active tier is healthy, 1 otherwise.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { SpawnFn, WhichFn } from "./keystores/types.ts";
import { probeLinuxSecretService } from "./keystores/linux-secret-service.ts";
import { probeLinuxPass } from "./keystores/linux-pass.ts";
import {
  defaultEncryptedFilePath,
  inspectEncryptedFile,
} from "./keystores/encrypted-file.ts";
import { isWincredReachable } from "./keystores/windows-credential.ts";

export interface TierStatus {
  tier: 1 | 2 | 3;
  /** Backend label (e.g. "LinuxSecretService (libsecret)"). */
  name: string;
  /** True when this tier would be selectable today. */
  reachable: boolean;
  /** One-line summary — present when not reachable. */
  reason?: string;
  /** Concrete fix instructions when not reachable. */
  fix?: string;
}

export interface DoctorReport {
  /** "darwin" | "linux" | "win32" | other. */
  platform: NodeJS.Platform;
  /** True when at least one tier is reachable. */
  ok: boolean;
  /** Tiers in order; first reachable one is the active tier. */
  tiers: TierStatus[];
  /** Convenience: which tier is currently active, or null. */
  activeTier: TierStatus | null;
  /** Extra notes for the user. */
  notes: string[];
}

export interface DoctorOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  spawn?: SpawnFn;
  which?: WhichFn;
  encryptedFilePath?: string;
}

function isOnPath(binary: string, spawn?: SpawnFn): boolean {
  const s: SpawnFn =
    spawn ??
    ((cmd, args, o) =>
      spawnSync(cmd, args as string[], {
        ...o,
        encoding: o?.encoding ?? "utf8",
      }) as ReturnType<SpawnFn>);
  try {
    const r = s(binary, ["--version"], { encoding: "utf8" });
    return r.status != null;
  } catch {
    return false;
  }
}

export function doctorReport(opts: DoctorOptions = {}): DoctorReport {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const which: WhichFn = opts.which ?? ((b) => isOnPath(b, opts.spawn));
  const tiers: TierStatus[] = [];
  const notes: string[] = [];

  if (platform === "darwin") {
    tiers.push({
      tier: 1,
      name: "macOS Keychain",
      // We don't probe the real Keychain here — `/usr/bin/security`
      // is always present on macOS. If it weren't, the resolver
      // would have surfaced that elsewhere.
      reachable: true,
    });
  } else if (platform === "linux") {
    // ---- Tier 1: Secret Service ----
    const sToolPresent = which("secret-tool");
    const ssReachable = sToolPresent && probeLinuxSecretService({ spawn: opts.spawn });
    tiers.push({
      tier: 1,
      name: "LinuxSecretService (libsecret)",
      reachable: ssReachable,
      ...(ssReachable
        ? {}
        : !sToolPresent
          ? {
              reason: "secret-tool not on PATH",
              fix:
                "apt install libsecret-tools  (Debian/Ubuntu)\n" +
                "dnf install libsecret        (Fedora)\n" +
                "pacman -S libsecret          (Arch)",
            }
          : {
              reason: "secret-tool present but no Secret Service on D-Bus",
              fix:
                "Usually means a headless / SSH / container session.\n" +
                "Either run stm from a desktop session, or fall through to\n" +
                "Tier 2 (pass) by installing `pass` and running `pass init`.",
            }),
    });

    // ---- Tier 2: pass ----
    const passPresent = which("pass");
    const passReachable = passPresent && probeLinuxPass({ spawn: opts.spawn });
    tiers.push({
      tier: 2,
      name: "LinuxPass (pass + GPG)",
      reachable: passReachable,
      ...(passReachable
        ? {}
        : !passPresent
          ? {
              reason: "pass not on PATH",
              fix:
                "apt install pass              (Debian/Ubuntu)\n" +
                "dnf install pass              (Fedora)\n" +
                "pacman -S pass                (Arch)\n" +
                "then: gpg --quick-generate-key 'your@email' default default 1y\n" +
                "      pass init your@email",
            }
          : {
              reason: "pass installed but no usable GPG store",
              fix:
                "gpg --quick-generate-key 'your@email' default default 1y\n" +
                "pass init your@email\n" +
                "Then re-run `stm doctor` to confirm Tier 2 is reachable.",
            }),
    });

    // ---- Tier 3: EncryptedFile ----
    const filePath = opts.encryptedFilePath ?? defaultEncryptedFilePath();
    const inspect = inspectEncryptedFile(filePath);
    const allowedByEnv = env.STM_ALLOW_FILE_BACKEND === "1";
    const tier3Reachable = inspect.exists || allowedByEnv;
    tiers.push({
      tier: 3,
      name: "EncryptedFile (0600, PBKDF2-SHA512)",
      reachable: tier3Reachable,
      ...(tier3Reachable
        ? {}
        : {
            reason:
              "opt-in tier; no vault file at " +
              filePath +
              " and STM_ALLOW_FILE_BACKEND is not set",
            fix:
              "If you want to use the encrypted-file fallback, set\n" +
              "STM_ALLOW_FILE_BACKEND=1 and re-run stm. You'll be\n" +
              "prompted for a passphrase on first write.",
          }),
    });
    if (inspect.exists && !inspect.modeOK) {
      notes.push(
        `Vault file at ${filePath} has loose permissions. Run: chmod 0600 ${filePath}`,
      );
    }
    if (inspect.exists && !inspect.magicOK) {
      notes.push(
        `Vault file at ${filePath} doesn't start with the stm magic bytes — ` +
          "is something else writing here?",
      );
    }
  } else if (platform === "win32") {
    const reachable = isWincredReachable();
    tiers.push({
      tier: 1,
      name: "Windows Credential Manager (DPAPI)",
      reachable,
      ...(reachable
        ? {}
        : {
            reason: "advapi32.dll could not be loaded",
            fix:
              "Run stm from an interactive Windows session (not a service\n" +
              "account or restricted sandbox). If the failure persists, set\n" +
              "STM_KEYSTORE=encrypted-file as an opt-in fallback.",
          }),
    });
  } else {
    tiers.push({
      tier: 1,
      name: `platform "${platform}"`,
      reachable: false,
      reason: "no backend mapping yet for this platform",
      fix: "Track specs/cross-platform-and-codex.md for the roadmap.",
    });
  }

  const activeTier = tiers.find((t) => t.reachable) ?? null;
  return {
    platform,
    ok: activeTier !== null,
    tiers,
    activeTier,
    notes,
  };
}

/** Render a `doctorReport()` result as plain text for the CLI. */
export function formatDoctorReport(r: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`keystore tiers (${r.platform}):`);
  for (const t of r.tiers) {
    const mark = t.reachable
      ? t === r.activeTier
        ? "✓"
        : " "
      : "✗";
    const tag = t === r.activeTier ? "  (active)" : "";
    lines.push(`  ${mark} Tier ${t.tier} — ${t.name}${tag}`);
    if (!t.reachable && t.reason) {
      lines.push(`      ${t.reason}`);
    }
    if (!t.reachable && t.fix) {
      for (const fixLine of t.fix.split("\n")) {
        lines.push(`      Fix: ${fixLine}`);
      }
    }
  }
  if (r.notes.length > 0) {
    lines.push("");
    lines.push("Notes:");
    for (const n of r.notes) lines.push(`  • ${n}`);
  }
  if (!r.ok) {
    lines.push("");
    lines.push("No keystore tier is reachable. Pick a fix above and re-run.");
  }
  return lines.join("\n") + "\n";
}
