// KeyStore tests (specs/cross-platform-and-codex.md §4.1, §5).
//
// The resolver is tested with a fully mocked `spawn` so the suite runs
// on macOS dev machines without needing a Linux host or secret-tool
// installation. Each backend's argv shape is asserted explicitly —
// that's the load-bearing contract with the underlying CLI.

import { test, expect, beforeEach, afterAll } from "bun:test";
import { createMacKeyStore } from "../src/keystores/mac.ts";
import {
  createLinuxSecretServiceKeyStore,
  probeLinuxSecretService,
} from "../src/keystores/linux-secret-service.ts";
import {
  selectKeyStore,
  _resetKeyStoreCache,
} from "../src/keystores/index.ts";
import type { SpawnFn } from "../src/keystores/types.ts";

beforeEach(() => _resetKeyStoreCache());
// Don't leak a forced backend (e.g. "win32 unsupported") into other
// test files. Subsequent files re-resolve against process.platform.
afterAll(() => _resetKeyStoreCache());

/**
 * Build a recording spawn function. Returns `{ spawn, calls }` —
 * `calls` is the in-order list of every invocation with its argv,
 * stdin input, and the response we sent back.
 */
function recordingSpawn(
  responses: Array<{
    status: number;
    stdout?: string;
    stderr?: string;
  }>,
): {
  spawn: SpawnFn;
  calls: Array<{ command: string; args: string[]; input?: string }>;
} {
  const calls: Array<{ command: string; args: string[]; input?: string }> = [];
  let idx = 0;
  const spawn: SpawnFn = (command, args, opts) => {
    calls.push({ command, args: args as string[], input: opts?.input });
    const r = responses[idx] ?? { status: 0, stdout: "", stderr: "" };
    idx++;
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { spawn, calls };
}

// ---- macOS backend ------------------------------------------------------

test("MacKeyStore.set shells out to `security add-generic-password -U -s ... -a ref -w value`", () => {
  const { spawn, calls } = recordingSpawn([{ status: 0 }]);
  const ks = createMacKeyStore({ spawn });
  ks.set("ref-123", "secret-value");
  expect(calls.length).toBe(1);
  expect(calls[0].command).toBe("/usr/bin/security");
  expect(calls[0].args[0]).toBe("add-generic-password");
  expect(calls[0].args).toContain("-U");
  expect(calls[0].args).toContain("-a");
  expect(calls[0].args).toContain("ref-123");
  expect(calls[0].args).toContain("-w");
  expect(calls[0].args).toContain("secret-value");
});

test("MacKeyStore.set throws with the binary's stderr on non-zero exit", () => {
  const { spawn } = recordingSpawn([{ status: 1, stderr: "could not access default keychain" }]);
  const ks = createMacKeyStore({ spawn });
  expect(() => ks.set("r", "v")).toThrow(/could not access default keychain/);
});

test("MacKeyStore.get strips the trailing newline `security -w` adds", () => {
  const { spawn } = recordingSpawn([{ status: 0, stdout: "the-secret\n" }]);
  const ks = createMacKeyStore({ spawn });
  expect(ks.get("r")).toBe("the-secret");
});

test("MacKeyStore.get returns null on non-zero exit (item missing)", () => {
  const { spawn } = recordingSpawn([{ status: 44, stderr: "" }]);
  const ks = createMacKeyStore({ spawn });
  expect(ks.get("r")).toBeNull();
});

test("MacKeyStore.describe returns the documented label", () => {
  expect(createMacKeyStore({ spawn: recordingSpawn([]).spawn }).describe()).toBe("macOS Keychain");
});

// ---- Linux Secret Service backend ---------------------------------------

test("LinuxSecretServiceKeyStore.set pipes the secret via stdin (NOT argv)", () => {
  const { spawn, calls } = recordingSpawn([{ status: 0 }]);
  const ks = createLinuxSecretServiceKeyStore({ spawn });
  ks.set("ref-xyz", "a-very-secret-value");
  expect(calls.length).toBe(1);
  expect(calls[0].command).toBe("secret-tool");
  expect(calls[0].args[0]).toBe("store");
  // Load-bearing posture upgrade: the secret MUST NOT appear in argv.
  // This assertion is the test guarding that invariant.
  expect(calls[0].args).not.toContain("a-very-secret-value");
  // It comes through stdin instead.
  expect(calls[0].input).toBe("a-very-secret-value");
  // Attributes are: service subscribetome key ref-xyz
  expect(calls[0].args).toContain("service");
  expect(calls[0].args).toContain("subscribetome");
  expect(calls[0].args).toContain("key");
  expect(calls[0].args).toContain("ref-xyz");
});

test("LinuxSecretServiceKeyStore.set throws with stderr on non-zero exit", () => {
  const { spawn } = recordingSpawn([{ status: 1, stderr: "no service" }]);
  const ks = createLinuxSecretServiceKeyStore({ spawn });
  expect(() => ks.set("r", "v")).toThrow(/no service/);
});

test("LinuxSecretServiceKeyStore.get strips one trailing newline", () => {
  const { spawn } = recordingSpawn([{ status: 0, stdout: "looked-up\n" }]);
  const ks = createLinuxSecretServiceKeyStore({ spawn });
  expect(ks.get("r")).toBe("looked-up");
});

test("LinuxSecretServiceKeyStore.get returns null on non-zero exit", () => {
  const { spawn } = recordingSpawn([{ status: 1 }]);
  const ks = createLinuxSecretServiceKeyStore({ spawn });
  expect(ks.get("missing")).toBeNull();
});

test("LinuxSecretServiceKeyStore.delete uses `secret-tool clear` with attributes", () => {
  const { spawn, calls } = recordingSpawn([{ status: 0 }]);
  const ks = createLinuxSecretServiceKeyStore({ spawn });
  ks.delete("ref-bye");
  expect(calls[0].args[0]).toBe("clear");
  expect(calls[0].args).toContain("ref-bye");
});

test("LinuxSecretServiceKeyStore.describe returns the documented label", () => {
  expect(
    createLinuxSecretServiceKeyStore({ spawn: recordingSpawn([]).spawn }).describe(),
  ).toBe("Linux Secret Service (libsecret)");
});

test("probeLinuxSecretService returns true when secret-tool exits 0 or 1", () => {
  expect(
    probeLinuxSecretService({ spawn: recordingSpawn([{ status: 1 }]).spawn }),
  ).toBe(true);
  expect(
    probeLinuxSecretService({ spawn: recordingSpawn([{ status: 0 }]).spawn }),
  ).toBe(true);
});

test("probeLinuxSecretService returns false when secret-tool can't reach D-Bus (exit 127)", () => {
  expect(
    probeLinuxSecretService({ spawn: recordingSpawn([{ status: 127 }]).spawn }),
  ).toBe(false);
});

// ---- Resolver -----------------------------------------------------------

test("selectKeyStore returns MacKeyStore on darwin by default", () => {
  const ks = selectKeyStore({
    force: true,
    platform: "darwin",
    env: {},
  });
  expect(ks.describe()).toBe("macOS Keychain");
});

test("selectKeyStore picks LinuxSecretService on linux when secret-tool + D-Bus are usable", () => {
  // `which` returns true (binary present), `probe` returns exit 1 = ok
  const { spawn } = recordingSpawn([{ status: 1 }]);
  const ks = selectKeyStore({
    force: true,
    platform: "linux",
    env: {},
    spawn,
    which: () => true,
  });
  expect(ks.describe()).toBe("Linux Secret Service (libsecret)");
});

test("selectKeyStore returns an unsupported store on linux without secret-tool", () => {
  const ks = selectKeyStore({
    force: true,
    platform: "linux",
    env: {},
    which: () => false,
  });
  expect(ks.describe()).toContain("secret-tool not found");
  // Operations surface a friendly error rather than silently doing nothing.
  expect(() => ks.set("r", "v")).toThrow(/no usable keystore/);
});

test("selectKeyStore returns an unsupported store when D-Bus probe fails", () => {
  const { spawn } = recordingSpawn([{ status: 127 }]);
  const ks = selectKeyStore({
    force: true,
    platform: "linux",
    env: {},
    spawn,
    which: () => true, // secret-tool exists but...
  });
  expect(ks.describe()).toContain("no Secret Service is reachable");
  expect(() => ks.get("r")).toThrow(/no usable keystore/);
});

test("STM_KEYSTORE override wins regardless of platform", () => {
  const ks = selectKeyStore({
    force: true,
    platform: "darwin",
    env: { STM_KEYSTORE: "linux-secret-service" },
    spawn: recordingSpawn([]).spawn,
  });
  expect(ks.describe()).toBe("Linux Secret Service (libsecret)");
});

test("STM_KEYSTORE override accepts the documented aliases", () => {
  for (const alias of ["mac", "macos", "keychain"]) {
    const ks = selectKeyStore({
      force: true,
      platform: "linux", // override should beat the platform default
      env: { STM_KEYSTORE: alias },
    });
    expect(ks.describe()).toBe("macOS Keychain");
  }
  for (const alias of ["linux", "libsecret", "secret-service", "linux-secret-service"]) {
    const ks = selectKeyStore({
      force: true,
      platform: "darwin",
      env: { STM_KEYSTORE: alias },
    });
    expect(ks.describe()).toBe("Linux Secret Service (libsecret)");
  }
});

test("STM_KEYSTORE override with an unknown value yields a clear unsupported store", () => {
  const ks = selectKeyStore({
    force: true,
    platform: "darwin",
    env: { STM_KEYSTORE: "totally-made-up" },
  });
  expect(ks.describe()).toContain("STM_KEYSTORE=");
  expect(ks.describe()).toContain("not a known backend");
});

test("selectKeyStore on an unsupported platform (win32) yields an honest error", () => {
  const ks = selectKeyStore({
    force: true,
    platform: "win32" as any,
    env: {},
  });
  expect(ks.describe()).toContain("win32");
  expect(() => ks.set("r", "v")).toThrow(/not yet supported/);
});
