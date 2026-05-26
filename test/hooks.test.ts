import { test, expect, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";

const DB = join(tmpdir(), `stm-test-hooks-${process.pid}.sqlite`);
const KC = process.env.STM_KEYCHAIN_SERVICE || "subscribetome-test";
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const ENV = { ...process.env, STM_DB: DB, STM_KEYCHAIN_SERVICE: KC };

// Point THIS process at the same keychain service the spawned hooks use (they
// get STM_KEYCHAIN_SERVICE via ENV). keychainService() reads the env on each
// call, so the key seeded below in-process and the keys the hooks resolve in a
// subprocess land in — and are read from — one shared service.
process.env.STM_KEYCHAIN_SERVICE = KC;

// Seed one resolvable key.
{
  const s = new Store(DB);
  s.addKey({ tool: "seedtool", label: "default", value: "SEED-SECRET-12345" });
  s.close();
}

interface HookResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runHook(hook: string, payload: object): HookResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI, "hook", hook], {
      input: JSON.stringify(payload),
      env: ENV,
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e: any) {
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

afterAll(() => {
  for (let i = 0; i < 100; i++) {
    try {
      execFileSync("/usr/bin/security", ["delete-generic-password", "-s", KC], {
        stdio: "ignore",
      });
    } catch {
      break;
    }
  }
  for (const s of ["", "-shm", "-wal"]) {
    try {
      rmSync(DB + s);
    } catch {
      /* ignore */
    }
  }
});

test("PreToolUse substitutes a valid placeholder via updatedInput", () => {
  const r = runHook("pretooluse", {
    tool_name: "Bash",
    tool_input: { command: "echo {{stm:seedtool:default}}", description: "d" },
  });
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  expect(out.hookSpecificOutput.updatedInput.command).toBe("echo SEED-SECRET-12345");
  expect(out.hookSpecificOutput.updatedInput.description).toBe("d"); // preserved
});

test("PreToolUse passes through a command with no placeholder", () => {
  const r = runHook("pretooluse", {
    tool_name: "Bash",
    tool_input: { command: "ls -la" },
  });
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("");
});

test("PreToolUse blocks a malformed near-miss", () => {
  const r = runHook("pretooluse", {
    tool_name: "Bash",
    tool_input: { command: "echo {{ stm:seedtool }}" },
  });
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("malformed");
});

test("PreToolUse blocks an unresolved placeholder", () => {
  const r = runHook("pretooluse", {
    tool_name: "Bash",
    tool_input: { command: "echo {{stm:ghost:none}}" },
  });
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("cannot resolve");
});

test("PreToolUse allows a placeholder written into a file", () => {
  const r = runHook("pretooluse", {
    tool_name: "Write",
    tool_input: {
      file_path: "/tmp/x",
      content: "OPENAI_API_KEY={{stm:seedtool:default}}",
    },
  });
  expect(r.code).toBe(0);
});

test("PreToolUse blocks a raw key written into a file", () => {
  const r = runHook("pretooluse", {
    tool_name: "Write",
    tool_input: {
      file_path: "/tmp/x",
      content: "OPENAI_API_KEY=sk-FAKErawkey1234567890abcdefghijklmno",
    },
  });
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("Write");
});

test("UserPromptSubmit blocks a prompt containing a raw key", () => {
  const r = runHook("userpromptsubmit", {
    prompt: "my key is sk-abcdefghij1234567890klmnopqrst use it",
  });
  expect(r.code).toBe(2);
});

test("UserPromptSubmit allows a clean prompt", () => {
  const r = runHook("userpromptsubmit", { prompt: "please run the tests" });
  expect(r.code).toBe(0);
});

test("UserPromptSubmit blocks a managed secret pasted verbatim (not key-shaped)", () => {
  // SEED-SECRET-12345 is the seeded value; 17 chars, no API-key shape, so the
  // shape channel misses it — the exact-value channel must catch it.
  const r = runHook("userpromptsubmit", {
    prompt: "connect to the db with password SEED-SECRET-12345 please",
  });
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("secret you manage");
});

test("PostToolUse flags output that leaked a managed key", () => {
  const r = runHook("posttooluse", {
    tool_name: "Bash",
    tool_input: { command: "echo {{stm:seedtool:default}}" },
    tool_response: "SEED-SECRET-12345",
  });
  expect(r.code).toBe(2);
  expect(r.stderr).toContain("leaked");
});

test("PostToolUse passes clean output through", () => {
  const r = runHook("posttooluse", {
    tool_name: "Bash",
    tool_input: { command: "echo hello" },
    tool_response: "hello",
  });
  expect(r.code).toBe(0);
});

test("SessionStart injects stm usage guidance", () => {
  const r = runHook("sessionstart", {
    hook_event_name: "SessionStart",
    source: "startup",
  });
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  const ctx: string = out.hookSpecificOutput.additionalContext;
  expect(ctx).toContain("stm list");
  expect(ctx).toContain("{{stm:<tool>:<label>}}");
  expect(ctx).toContain("/stm:dashboard");
});

// ---- PostToolUse mode toggle (v0.9.0) ------------------------------------

function runHookWithEnv(
  hook: string,
  payload: object,
  extraEnv: Record<string, string>,
): HookResult {
  // spawnSync (not execFileSync) so we capture stderr on exit 0 too —
  // execFileSync only surfaces stderr via the thrown error, which
  // means a successful run with stderr output (warn mode) loses it.
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const r = spawnSync(process.execPath, [CLI, "hook", hook], {
    input: JSON.stringify(payload),
    env: { ...ENV, ...extraEnv },
    encoding: "utf8",
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

test("PostToolUse default mode is block (no regression from v1)", () => {
  // Same payload as the existing leak test — no env override, no
  // STM_POSTTOOLUSE_MODE set. Must still exit 2.
  const r = runHook("posttooluse", {
    tool_name: "Bash",
    tool_input: { command: "echo {{stm:seedtool:default}}" },
    tool_response: "SEED-SECRET-12345",
  });
  expect(r.code).toBe(2);
});

test("PostToolUse warn mode reports but exits 0", () => {
  const r = runHookWithEnv(
    "posttooluse",
    {
      tool_name: "Bash",
      tool_input: { command: "echo {{stm:seedtool:default}}" },
      tool_response: "SEED-SECRET-12345",
    },
    { STM_POSTTOOLUSE_MODE: "warn" },
  );
  expect(r.code).toBe(0);
  // The alert text MUST still reach stderr — otherwise the user has
  // no signal at all and the warn mode would be silent.
  expect(r.stderr).toContain("leaked");
  expect(r.stderr).toContain("advisory only");
});

test("PostToolUse mode is case-insensitive (WARN, Warn, warn all work)", () => {
  for (const mode of ["WARN", "Warn", "warn"]) {
    const r = runHookWithEnv(
      "posttooluse",
      {
        tool_name: "Bash",
        tool_input: { command: "echo {{stm:seedtool:default}}" },
        tool_response: "SEED-SECRET-12345",
      },
      { STM_POSTTOOLUSE_MODE: mode },
    );
    expect(r.code).toBe(0);
  }
});

test("PostToolUse unrecognised mode falls back to block (safer default)", () => {
  const r = runHookWithEnv(
    "posttooluse",
    {
      tool_name: "Bash",
      tool_input: { command: "echo {{stm:seedtool:default}}" },
      tool_response: "SEED-SECRET-12345",
    },
    { STM_POSTTOOLUSE_MODE: "yolo" },
  );
  expect(r.code).toBe(2);
});

test("PostToolUse warn mode still passes clean output through (exit 0, no message)", () => {
  const r = runHookWithEnv(
    "posttooluse",
    {
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_response: "hi",
    },
    { STM_POSTTOOLUSE_MODE: "warn" },
  );
  expect(r.code).toBe(0);
  expect(r.stderr).toBe("");
});
