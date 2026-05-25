// LinuxPass backend tests — Tier 2 of the Linux fallback chain
// (v0.6.0, plan: specs/plans/v0.6-linux-headless.md).
//
// We use an injected `spawn` to drive the test — `pass` itself never
// runs. The load-bearing assertion is that the secret VALUE goes via
// stdin, not as an argv element (the same posture rule the Linux
// Secret Service backend enforces, the same one macOS v1 fails).

import { test, expect } from "bun:test";
import {
  createLinuxPassKeyStore,
  probeLinuxPass,
} from "../src/keystores/linux-pass.ts";
import type { SpawnFn } from "../src/keystores/types.ts";

function recordingSpawn(
  responses: Array<{ status: number; stdout?: string; stderr?: string }>,
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

// ---- HEADLINE: secret never in argv -------------------------------------

test("LinuxPass.set passes the secret via stdin, NEVER as an argv element", () => {
  const SECRET = "sk-this-must-go-via-stdin-not-argv-XXXXX";
  const { spawn, calls } = recordingSpawn([{ status: 0 }]);
  const ks = createLinuxPassKeyStore({ spawn });
  ks.set("alpha", SECRET);
  expect(calls.length).toBe(1);
  expect(calls[0].command).toBe("pass");
  // stdin carries the value
  expect(calls[0].input).toBe(SECRET);
  // argv carries the subcommand + namespaced path only
  expect(calls[0].args).toEqual(["insert", "--multiline", "-f", "subscribetome/alpha"]);
  // CRITICAL: no argv element contains the secret
  for (const a of calls[0].args) {
    expect(a).not.toContain(SECRET);
  }
});

// ---- set ----------------------------------------------------------------

test("LinuxPass.set namespaces the path as subscribetome/<ref>", () => {
  const { spawn, calls } = recordingSpawn([{ status: 0 }]);
  const ks = createLinuxPassKeyStore({ spawn });
  ks.set("openai-default", "v");
  expect(calls[0].args).toContain("subscribetome/openai-default");
});

test("LinuxPass.set throws with stderr on non-zero exit", () => {
  const { spawn } = recordingSpawn([
    { status: 1, stderr: "gpg: decryption failed: No secret key" },
  ]);
  const ks = createLinuxPassKeyStore({ spawn });
  expect(() => ks.set("x", "v")).toThrow(/No secret key/);
});

// ---- get ----------------------------------------------------------------

test("LinuxPass.get returns stdout with trailing newline stripped", () => {
  const { spawn } = recordingSpawn([{ status: 0, stdout: "the-secret\n" }]);
  const ks = createLinuxPassKeyStore({ spawn });
  expect(ks.get("r")).toBe("the-secret");
});

test("LinuxPass.get returns null on non-zero exit (entry missing)", () => {
  const { spawn } = recordingSpawn([{ status: 1, stderr: "is not in the password store." }]);
  const ks = createLinuxPassKeyStore({ spawn });
  expect(ks.get("ghost")).toBeNull();
});

// ---- delete -------------------------------------------------------------

test("LinuxPass.delete shells out to `pass rm -f subscribetome/<ref>` (idempotent)", () => {
  const { spawn, calls } = recordingSpawn([{ status: 0 }]);
  const ks = createLinuxPassKeyStore({ spawn });
  ks.delete("k");
  expect(calls[0].args).toEqual(["rm", "-f", "subscribetome/k"]);
});

// ---- describe -----------------------------------------------------------

test("LinuxPass.describe identifies as `pass + GPG`", () => {
  const ks = createLinuxPassKeyStore({ spawn: recordingSpawn([]).spawn });
  expect(ks.describe()).toBe("Linux Pass (pass + GPG)");
});

// ---- probeLinuxPass -----------------------------------------------------

test("probeLinuxPass returns true when both `pass version` and `pass ls` exit 0", () => {
  const { spawn } = recordingSpawn([
    { status: 0 }, // pass version
    { status: 0 }, // pass ls
  ]);
  expect(probeLinuxPass({ spawn })).toBe(true);
});

test("probeLinuxPass returns false when `pass version` exits non-zero", () => {
  const { spawn } = recordingSpawn([{ status: 127 }]);
  expect(probeLinuxPass({ spawn })).toBe(false);
});

test("probeLinuxPass returns false when `pass ls` exits non-zero (no GPG store init'd)", () => {
  const { spawn } = recordingSpawn([
    { status: 0 }, // pass version OK
    { status: 1, stderr: "Error: store is empty, try `pass init`" },
  ]);
  expect(probeLinuxPass({ spawn })).toBe(false);
});
