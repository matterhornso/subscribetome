// KeyStore resolver — picks a backend at startup.
//
// Decision order (specs/cross-platform-and-codex.md §5):
//   1. `$STM_KEYSTORE` override        — for CI and explicit overrides
//   2. Platform default                — macOS → MacKeychain;
//                                         Linux → LinuxSecretService
//                                                  (when D-Bus + libsecret available);
//                                         elsewhere → unsupported
//   3. (planned: LinuxPass, EncryptedFile fallbacks for headless Linux)
//
// `getKeyStore()` is a singleton — the resolved backend is cached for
// the process lifetime so we don't probe on every keychainSet call.
// Tests can pass `selectKeyStore({force})` to bypass the cache.
//
// The resolver surfaces failures honestly: if no backend is selectable
// (Linux without libsecret, Windows, etc.) the returned `unsupported`
// store throws a friendly error on every operation telling the user
// what to install. We never silently fall back to plaintext — the spec
// calls out gh CLI as the cautionary tale on this point.

import { spawnSync } from "node:child_process";
import type { KeyStore, SpawnFn, WhichFn } from "./types.ts";
import { createMacKeyStore } from "./mac.ts";
import {
  createLinuxSecretServiceKeyStore,
  probeLinuxSecretService,
} from "./linux-secret-service.ts";

export type { KeyStore } from "./types.ts";

let cache: KeyStore | null = null;

/** Test-only: reset the resolved-backend cache. */
export function _resetKeyStoreCache(): void {
  cache = null;
}

/**
 * Whether a binary appears to be on $PATH. We don't shell out to
 * `which` to avoid platform differences; instead we ask the binary
 * itself with a cheap flag.
 */
function isOnPath(binary: string, spawn?: SpawnFn): boolean {
  const s: SpawnFn = spawn ?? ((cmd, args, o) =>
    spawnSync(cmd, args as string[], { ...o, encoding: o?.encoding ?? "utf8" }) as ReturnType<SpawnFn>);
  try {
    const r = s(binary, ["--version"], { encoding: "utf8" });
    // Any non-null status means the OS could resolve the binary
    // (whether the flag itself worked or not). status: null typically
    // means ENOENT — binary missing.
    return r.status != null;
  } catch {
    return false;
  }
}

function createUnsupportedKeyStore(reason: string): KeyStore {
  return {
    set(): void {
      throw new Error(`no usable keystore on this host: ${reason}`);
    },
    get(): string | null {
      throw new Error(`no usable keystore on this host: ${reason}`);
    },
    delete(): void {
      throw new Error(`no usable keystore on this host: ${reason}`);
    },
    describe(): string {
      return `unsupported (${reason})`;
    },
  };
}

export interface SelectOptions {
  /**
   * Force re-detection even if a backend is already cached. Used by
   * tests and by `STM_KEYSTORE` overrides.
   */
  force?: boolean;
  /**
   * Override `process.platform` for testing.
   */
  platform?: NodeJS.Platform;
  /**
   * Override `process.env` for testing.
   */
  env?: Record<string, string | undefined>;
  /**
   * Injected spawn — used to mock libsecret presence and D-Bus
   * availability without touching the real host.
   */
  spawn?: SpawnFn;
  /**
   * Injected `which`-style probe. Falls back to `isOnPath` (a
   * cheap `--version` shell-out) when omitted.
   */
  which?: WhichFn;
}

/**
 * Resolve the active KeyStore. The result is cached unless `force:true`.
 * Test code should call `_resetKeyStoreCache()` between cases.
 */
export function selectKeyStore(opts: SelectOptions = {}): KeyStore {
  if (cache && !opts.force) return cache;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const which: WhichFn = opts.which ?? ((b) => isOnPath(b, opts.spawn));

  // 1. Explicit override — wins regardless of platform.
  const override = env.STM_KEYSTORE?.toLowerCase();
  if (override) {
    const picked = byName(override, opts);
    if (picked) {
      cache = picked;
      return cache;
    }
    // An invalid override is a hard error — better to fail loudly than
    // silently fall through to a different backend than the user asked
    // for.
    cache = createUnsupportedKeyStore(
      `STM_KEYSTORE="${override}" is not a known backend ` +
        `(try: mac, linux-secret-service)`,
    );
    return cache;
  }

  // 2. Platform default.
  if (platform === "darwin") {
    cache = createMacKeyStore({ spawn: opts.spawn });
    return cache;
  }
  if (platform === "linux") {
    if (!which("secret-tool")) {
      cache = createUnsupportedKeyStore(
        "secret-tool not found. Install libsecret " +
          "(Debian/Ubuntu: `apt install libsecret-tools`, " +
          "Fedora: `dnf install libsecret`, " +
          "Arch: `pacman -S libsecret`) and run `stm status` again.",
      );
      return cache;
    }
    if (!probeLinuxSecretService({ spawn: opts.spawn })) {
      cache = createUnsupportedKeyStore(
        "libsecret is installed but no Secret Service is reachable " +
          "on the D-Bus session bus. This usually means a headless or " +
          "SSH session with no desktop keyring daemon running. " +
          "Set STM_KEYSTORE to override, or run stm from a desktop " +
          "session.",
      );
      return cache;
    }
    cache = createLinuxSecretServiceKeyStore({ spawn: opts.spawn });
    return cache;
  }

  // 3. No mapping yet (Windows, BSD, …).
  cache = createUnsupportedKeyStore(
    `platform "${platform}" is not yet supported. ` +
      "Track specs/cross-platform-and-codex.md for the roadmap.",
  );
  return cache;
}

function byName(name: string, opts: SelectOptions): KeyStore | null {
  switch (name) {
    case "mac":
    case "macos":
    case "keychain":
      return createMacKeyStore({ spawn: opts.spawn });
    case "linux":
    case "linux-secret-service":
    case "libsecret":
    case "secret-service":
      return createLinuxSecretServiceKeyStore({ spawn: opts.spawn });
    default:
      return null;
  }
}

/**
 * The default keystore handle used by `keychain.ts`. Returns the
 * cached backend (lazily resolved on first call).
 */
export function getKeyStore(): KeyStore {
  return selectKeyStore();
}
