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
import type { KeyStore, MacFFI, SpawnFn, WhichFn, WincredFFI } from "./types.ts";
import { createMacKeyStore } from "./mac.ts";
import {
  createLinuxSecretServiceKeyStore,
  probeLinuxSecretService,
} from "./linux-secret-service.ts";
import {
  createWindowsCredentialKeyStore,
  isWincredReachable,
} from "./windows-credential.ts";
import { createLinuxPassKeyStore, probeLinuxPass } from "./linux-pass.ts";
import {
  createEncryptedFileKeyStore,
  encryptedFileExists,
  type PassphraseProvider,
} from "./encrypted-file.ts";

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
  /**
   * Injected Windows credential-API surface. Tests pass a recording
   * fake so the backend can be exercised on any platform without
   * dlopen-ing advapi32. Real callers leave this undefined and the
   * factory builds the bun:ffi binding lazily.
   */
  wincredFFI?: WincredFFI;
  /**
   * Injected macOS Security framework surface (v0.6.1). Symmetric
   * with `wincredFFI` — lets tests exercise the resolver branch
   * on any host without touching the real Keychain.
   */
  macFFI?: MacFFI;
  /**
   * Injected passphrase provider for the EncryptedFile backend.
   * Tests pin a value, `stm vault unlock` writes to the shared
   * in-memory cache and lets the default provider find it.
   */
  passphraseProvider?: PassphraseProvider;
  /**
   * Override the EncryptedFile path. Tests use a tmpdir; real
   * callers use the default XDG-conformant location.
   */
  encryptedFilePath?: string;
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
        `(try: mac, linux-secret-service, linux-pass, encrypted-file, windows-credential)`,
    );
    return cache;
  }

  // 2. Platform default.
  if (platform === "darwin") {
    cache = createMacKeyStore({ ffi: opts.macFFI });
    return cache;
  }
  if (platform === "linux") {
    // Three-tier chain per spec §5:
    //   1. LinuxSecretService (desktop standard, libsecret + D-Bus)
    //   2. LinuxPass           (pass + GPG, works over SSH)
    //   3. EncryptedFile       (last resort; opt-in via STM_ALLOW_FILE_BACKEND=1
    //                            on first touch — auto if the file exists)
    //
    // The resolver picks the HIGHEST tier that works and ANNOUNCES it
    // honestly (no silent downgrade — the gh-cli cautionary tale).
    if (which("secret-tool") && probeLinuxSecretService({ spawn: opts.spawn })) {
      cache = createLinuxSecretServiceKeyStore({ spawn: opts.spawn });
      return cache;
    }
    if (which("pass") && probeLinuxPass({ spawn: opts.spawn })) {
      cache = createLinuxPassKeyStore({ spawn: opts.spawn });
      return cache;
    }
    // Tier 3 is gated. The file existing IS the consent (the user
    // opted in once via STM_ALLOW_FILE_BACKEND=1, or by explicit
    // STM_KEYSTORE=encrypted-file). For a fresh install we never
    // auto-create the file silently.
    const fileExists = encryptedFileExists(opts.encryptedFilePath);
    const allowedByEnv = env.STM_ALLOW_FILE_BACKEND === "1";
    if (fileExists || allowedByEnv) {
      cache = createEncryptedFileKeyStore({
        filePath: opts.encryptedFilePath,
        passphraseProvider: opts.passphraseProvider,
      });
      return cache;
    }
    // No tier reachable — produce a diagnostic that names ALL THREE
    // tiers + what's needed. `stm doctor` parses similar signals and
    // formats them more nicely.
    cache = createUnsupportedKeyStore(
      "No Linux keystore is reachable on this host:\n" +
        "  · Tier 1 (Secret Service): " +
        (which("secret-tool")
          ? "secret-tool present but no D-Bus session bus / keyring daemon"
          : "secret-tool not installed (`apt install libsecret-tools` etc.)") +
        "\n" +
        "  · Tier 2 (pass):           " +
        (which("pass")
          ? "pass present but no usable GPG store (run `pass init <your-gpg-id>`)"
          : "pass not installed (`apt install pass` etc.)") +
        "\n" +
        "  · Tier 3 (EncryptedFile):  opt-in via STM_ALLOW_FILE_BACKEND=1 " +
        "(passphrase-derived AES-256-GCM, 0600). Run `stm doctor` for the full diagnosis.",
    );
    return cache;
  }

  if (platform === "win32") {
    // Windows Credential Manager via advapi32. Probe first so a
    // broken Bun FFI / restricted sandbox returns an honest
    // `unsupported (...)` rather than failing at the first set/get.
    if (!isWincredReachable({ ffi: opts.wincredFFI })) {
      cache = createUnsupportedKeyStore(
        "Windows Credential Manager is unreachable. This usually means " +
          "advapi32.dll could not be loaded — are you running stm in a " +
          "restricted sandbox, container, or service account without " +
          "Credential Manager access? Set STM_KEYSTORE to override, or " +
          "run stm from an interactive Windows session.",
      );
      return cache;
    }
    cache = createWindowsCredentialKeyStore({ ffi: opts.wincredFFI });
    return cache;
  }

  // 3. No mapping yet (BSD, sunos, …).
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
      return createMacKeyStore({ ffi: opts.macFFI });
    case "linux":
    case "linux-secret-service":
    case "libsecret":
    case "secret-service":
      return createLinuxSecretServiceKeyStore({ spawn: opts.spawn });
    case "linux-pass":
    case "pass":
      return createLinuxPassKeyStore({ spawn: opts.spawn });
    case "encrypted-file":
    case "file":
    case "encrypted":
      return createEncryptedFileKeyStore({
        filePath: opts.encryptedFilePath,
        passphraseProvider: opts.passphraseProvider,
      });
    case "windows":
    case "windows-credential":
    case "wincred":
    case "credential-manager":
      return createWindowsCredentialKeyStore({ ffi: opts.wincredFFI });
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
