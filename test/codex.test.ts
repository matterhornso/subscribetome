// Codex adapter tests (specs/cross-platform-and-codex.md §6).
//
// We test three layers in isolation:
//   1. `keyEnvName` — deterministic, collision-detectable mapping.
//   2. `buildInjectionPlan` — scope-awareness, collision surfacing,
//      stable output order. Uses a real on-disk Store with a fake key
//      sourced through the keychain CLI (the existing pattern in
//      test/store.test.ts).
//   3. `launchCodex` — with an injected spawn we assert the exact argv,
//      the env passed to codex, and CRITICALLY that no secret value ever
//      lands in argv. Exit-code propagation is checked too.

import { test, expect, afterAll, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import {
  keyEnvName,
  buildInjectionPlan,
  resolveInjectionValues,
  codexConfigOverrides,
  launchCodex,
  launchBanner,
  codexAgentLabel,
  claudeCodeAgentLabel,
  listSupportedAgents,
} from "../src/agents/codex.ts";

const DB = join(tmpdir(), `stm-test-codex-${process.pid}.sqlite`);
const KC = process.env.STM_KEYCHAIN_SERVICE || "subscribetome-test";
process.env.STM_KEYCHAIN_SERVICE = KC;

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

// ---- keyEnvName ------------------------------------------------------------

test("keyEnvName produces STM_<TOOL>_<LABEL> with uppercased segments", () => {
  expect(keyEnvName("openai", "default")).toBe("STM_OPENAI_DEFAULT");
  expect(keyEnvName("anthropic", "admin-key")).toBe("STM_ANTHROPIC_ADMIN_KEY");
});

test("keyEnvName replaces every non-[A-Z0-9_] character with underscore", () => {
  // hyphens, dots, slashes — anything bash wouldn't accept as a var name.
  expect(keyEnvName("open-router", "rotated-2")).toBe("STM_OPEN_ROUTER_ROTATED_2");
  expect(keyEnvName("ai.foo", "bar/baz")).toBe("STM_AI_FOO_BAR_BAZ");
});

test("keyEnvName is deterministic: same input → same output", () => {
  expect(keyEnvName("openai", "default")).toBe(keyEnvName("openai", "default"));
});

// ---- buildInjectionPlan ---------------------------------------------------

test("buildInjectionPlan with no project falls back to all active keys", () => {
  const s = new Store(DB);
  s.addKey({ tool: "openai", label: "default", value: "v1" });
  s.addKey({ tool: "anthropic", label: "default", value: "v2" });
  const plan = buildInjectionPlan({ store: s, cwd: "/no/registered/project" });
  expect(plan.project).toBeNull();
  expect(plan.scoped).toBe(false);
  const names = plan.entries.map((e) => e.envName);
  expect(names).toContain("STM_OPENAI_DEFAULT");
  expect(names).toContain("STM_ANTHROPIC_DEFAULT");
  s.close();
});

test("buildInjectionPlan returns entries sorted alphabetically by envName", () => {
  const s = new Store(DB);
  // Insert in reverse-alphabetical to prove sort is by output, not insertion.
  s.addKey({ tool: "zzz-late", label: "default", value: "v" });
  // openai+anthropic already in the DB from the previous test (single-tmpfile)
  const plan = buildInjectionPlan({ store: s, cwd: "/no/registered/project" });
  const names = plan.entries.map((e) => e.envName);
  const sorted = [...names].sort();
  expect(names).toEqual(sorted);
  s.close();
});

test("buildInjectionPlan with a matching project + non-empty scope uses only scope", () => {
  const dbPath = join(tmpdir(), `stm-test-codex-scope-${process.pid}.sqlite`);
  const s = new Store(dbPath);
  try {
    s.addKey({ tool: "openai", label: "default", value: "v1" });
    s.addKey({ tool: "anthropic", label: "default", value: "v2" });
    s.addKey({ tool: "stripe", label: "default", value: "v3" });
    const p = s.addProject({ path: "/tmp/codex-proj", name: "codex-proj" });
    s.addProjectScope(p.id, "openai", "default");
    s.addProjectScope(p.id, "anthropic", "default");
    const plan = buildInjectionPlan({ store: s, cwd: "/tmp/codex-proj/src" });
    expect(plan.project?.name).toBe("codex-proj");
    expect(plan.scoped).toBe(true);
    const names = plan.entries.map((e) => e.envName).sort();
    expect(names).toEqual(["STM_ANTHROPIC_DEFAULT", "STM_OPENAI_DEFAULT"]);
    // Stripe is NOT in scope → not injected.
    expect(names).not.toContain("STM_STRIPE_DEFAULT");
  } finally {
    s.close();
    for (const sfx of ["", "-shm", "-wal"]) {
      try { rmSync(dbPath + sfx); } catch { /* ignore */ }
    }
  }
});

test("buildInjectionPlan with a matching project + EMPTY scope falls back to all keys", () => {
  const dbPath = join(tmpdir(), `stm-test-codex-emptyscope-${process.pid}.sqlite`);
  const s = new Store(dbPath);
  try {
    s.addKey({ tool: "openai", label: "default", value: "v1" });
    const p = s.addProject({ path: "/tmp/codex-empty", name: "codex-empty" });
    // No addProjectScope calls — scope is empty.
    const plan = buildInjectionPlan({ store: s, cwd: "/tmp/codex-empty" });
    expect(plan.project?.name).toBe("codex-empty");
    // The launcher's contract: empty-scope project is NOT "inject nothing" —
    // that would silently break codex. Falls back to all active keys, with
    // `scoped: false` so the banner can say so honestly.
    expect(plan.scoped).toBe(false);
    expect(plan.entries.map((e) => e.envName)).toContain("STM_OPENAI_DEFAULT");
  } finally {
    s.close();
    for (const sfx of ["", "-shm", "-wal"]) {
      try { rmSync(dbPath + sfx); } catch { /* ignore */ }
    }
  }
});

test("buildInjectionPlan surfaces env-var name collisions instead of silently overwriting", () => {
  const dbPath = join(tmpdir(), `stm-test-codex-collision-${process.pid}.sqlite`);
  const s = new Store(dbPath);
  try {
    // Two (tool, label) pairs that normalize to the SAME env name. Without
    // collision detection a launch would silently overwrite one secret with
    // the other — exactly the failure mode the spec calls out.
    s.addKey({ tool: "open-ai", label: "default", value: "v-collide" });
    s.addKey({ tool: "open", label: "ai-default", value: "v-collide-2" });
    // Both map to STM_OPEN_AI_DEFAULT.
    const plan = buildInjectionPlan({ store: s, cwd: "/no/project" });
    expect(plan.collisions.length).toBe(1);
    expect(plan.collisions[0].envName).toBe("STM_OPEN_AI_DEFAULT");
    expect(plan.collisions[0].tools).toContain("open-ai:default");
    expect(plan.collisions[0].tools).toContain("open:ai-default");
    // Colliding entries are EXCLUDED from `entries` — the launcher reads
    // collisions and refuses to start.
    expect(
      plan.entries.find((e) => e.envName === "STM_OPEN_AI_DEFAULT"),
    ).toBeUndefined();
  } finally {
    s.close();
    for (const sfx of ["", "-shm", "-wal"]) {
      try { rmSync(dbPath + sfx); } catch { /* ignore */ }
    }
  }
});

test("buildInjectionPlan skips revoked keys", () => {
  const dbPath = join(tmpdir(), `stm-test-codex-revoked-${process.pid}.sqlite`);
  const s = new Store(dbPath);
  try {
    s.addKey({ tool: "openai", label: "default", value: "v1" });
    s.addKey({ tool: "openai", label: "rotated", value: "v2" });
    s.revokeKey("openai", "default");
    const plan = buildInjectionPlan({ store: s, cwd: "/no/project" });
    const names = plan.entries.map((e) => e.envName);
    expect(names).toContain("STM_OPENAI_ROTATED");
    expect(names).not.toContain("STM_OPENAI_DEFAULT");
  } finally {
    s.close();
    for (const sfx of ["", "-shm", "-wal"]) {
      try { rmSync(dbPath + sfx); } catch { /* ignore */ }
    }
  }
});

// ---- resolveInjectionValues ----------------------------------------------

test("resolveInjectionValues reads every entry's value from the keystore", () => {
  const dbPath = join(tmpdir(), `stm-test-codex-resolve-${process.pid}.sqlite`);
  const s = new Store(dbPath);
  try {
    s.addKey({ tool: "openai", label: "default", value: "sk-openai-test-1" });
    s.addKey({ tool: "anthropic", label: "default", value: "sk-anth-test-2" });
    const plan = buildInjectionPlan({ store: s, cwd: "/no/project" });
    const vals = resolveInjectionValues({ store: s, plan });
    expect(vals.STM_OPENAI_DEFAULT).toBe("sk-openai-test-1");
    expect(vals.STM_ANTHROPIC_DEFAULT).toBe("sk-anth-test-2");
  } finally {
    s.close();
    for (const sfx of ["", "-shm", "-wal"]) {
      try { rmSync(dbPath + sfx); } catch { /* ignore */ }
    }
  }
});

// ---- codexConfigOverrides ------------------------------------------------

test("codexConfigOverrides emits the STM_* shell_environment_policy pair", () => {
  const args = codexConfigOverrides();
  expect(args).toContain("-c");
  expect(args.some((a) => /shell_environment_policy\.inherit/.test(a))).toBe(true);
  expect(args.some((a) => /shell_environment_policy\.include_only/.test(a) && /STM_\*/.test(a))).toBe(true);
});

test("codexConfigOverrides does NOT carry any secret value", () => {
  // The argv carries env-var NAMES (which are not secret) — never values.
  const args = codexConfigOverrides();
  // Smoke check: no recognized API-key shapes anywhere in argv.
  for (const a of args) {
    expect(/sk-[a-zA-Z0-9]{20,}/.test(a)).toBe(false);
    expect(/eyJ[A-Za-z0-9._-]{10,}/.test(a)).toBe(false);
  }
});

// ---- launchCodex ---------------------------------------------------------

/** Build a fake spawn that captures arguments and synthesizes an "exit". */
function fakeSpawn(opts: { exitCode?: number; signal?: NodeJS.Signals; throwError?: NodeJS.ErrnoException }) {
  const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv; stdio: string }> = [];
  const exitListeners: Array<(code: number | null, sig: NodeJS.Signals | null) => void> = [];
  const errorListeners: Array<(e: NodeJS.ErrnoException) => void> = [];
  const spawnFn = (command: string, args: readonly string[], options: any) => {
    calls.push({ command, args, env: options.env, stdio: options.stdio });
    const child = {
      on(event: string, listener: any) {
        if (event === "exit") exitListeners.push(listener);
        if (event === "error") errorListeners.push(listener);
      },
    };
    // Schedule the exit event on the next tick — mirrors real spawn semantics.
    queueMicrotask(() => {
      if (opts.throwError) {
        for (const l of errorListeners) l(opts.throwError);
      } else {
        for (const l of exitListeners) l(opts.exitCode ?? 0, opts.signal ?? null);
      }
    });
    return child;
  };
  return { spawnFn, calls };
}

test("launchCodex passes values via env, never via argv", async () => {
  const { spawnFn, calls } = fakeSpawn({ exitCode: 0 });
  const SECRET = "sk-this-must-not-leak-into-argv-AAAAA";
  await launchCodex({
    values: { STM_OPENAI_DEFAULT: SECRET },
    userArgs: ["--model", "o4-mini", "hello"],
    spawnFn,
  });
  expect(calls.length).toBe(1);
  // Argv must NOT contain the secret value anywhere.
  for (const a of calls[0].args) {
    expect(a).not.toBe(SECRET);
    expect(a).not.toContain(SECRET);
  }
  // But the child's env MUST carry it.
  expect(calls[0].env.STM_OPENAI_DEFAULT).toBe(SECRET);
});

test("launchCodex prefixes user args with codex --config overrides", async () => {
  const { spawnFn, calls } = fakeSpawn({ exitCode: 0 });
  await launchCodex({
    values: {},
    userArgs: ["chat", "--model", "o4-mini"],
    spawnFn,
  });
  // The first --config block must be the shell_environment_policy overrides;
  // user args follow.
  const args = calls[0].args;
  const firstUserIdx = args.indexOf("chat");
  // Everything before "chat" should be -c / shell_environment_policy entries.
  for (let i = 0; i < firstUserIdx; i++) {
    expect(args[i] === "-c" || /shell_environment_policy/.test(args[i])).toBe(true);
  }
  expect(firstUserIdx).toBeGreaterThan(0);
  // The user args appear unmodified, in order.
  expect(args.slice(firstUserIdx)).toEqual(["chat", "--model", "o4-mini"]);
});

test("launchCodex propagates the child's exit code", async () => {
  const { spawnFn } = fakeSpawn({ exitCode: 42 });
  const r = await launchCodex({ values: {}, userArgs: [], spawnFn });
  expect(r.code).toBe(42);
  expect(r.signal).toBeNull();
});

test("launchCodex surfaces ENOENT with an install hint", async () => {
  const enoent = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
  const { spawnFn } = fakeSpawn({ throwError: enoent });
  await expect(
    launchCodex({ values: {}, userArgs: [], spawnFn }),
  ).rejects.toThrow(/codex binary not found/);
});

test("launchCodex inherits the parent env but our values win on overlap", async () => {
  const { spawnFn, calls } = fakeSpawn({ exitCode: 0 });
  await launchCodex({
    values: { STM_OPENAI_DEFAULT: "from-stm", PATH_LIKE_VAR: "stm-wins" },
    userArgs: [],
    parentEnv: { PATH_LIKE_VAR: "parent-value", UNRELATED: "kept" },
    spawnFn,
  });
  expect(calls[0].env.STM_OPENAI_DEFAULT).toBe("from-stm");
  expect(calls[0].env.PATH_LIKE_VAR).toBe("stm-wins"); // stm-supplied wins
  expect(calls[0].env.UNRELATED).toBe("kept");        // pass-through preserved
});

// ---- launchBanner --------------------------------------------------------

test("launchBanner names every env var but never carries a value", () => {
  const banner = launchBanner({
    entries: [
      { tool: "openai", label: "default", envName: "STM_OPENAI_DEFAULT", placeholder: "{{stm:openai:default}}" },
    ],
    collisions: [],
    project: null,
    scoped: false,
  });
  expect(banner).toContain("STM_OPENAI_DEFAULT");
  // Spec invariant: banner must show the security framing every time.
  expect(banner.toLowerCase()).toContain("session-env");
  expect(banner.toLowerCase()).toContain("weaker");
});

test("launchBanner is explicit when no project is matched", () => {
  const banner = launchBanner({
    entries: [],
    collisions: [],
    project: null,
    scoped: false,
  });
  expect(banner.toLowerCase()).toContain("no project");
});

test("launchBanner is explicit when a project is matched and scoped", () => {
  const banner = launchBanner({
    entries: [],
    collisions: [],
    project: { id: 1, name: "alpha", path: "/tmp/alpha" },
    scoped: true,
  });
  expect(banner).toContain("alpha");
});

// ---- labels --------------------------------------------------------------

test("agent labels are stable strings (load-bearing for status + dashboard)", () => {
  expect(codexAgentLabel()).toMatch(/Codex.*session-env mode/);
  expect(claudeCodeAgentLabel()).toMatch(/Claude Code.*per-command/);
});

test("listSupportedAgents returns both adapters in stable order", () => {
  const list = listSupportedAgents();
  expect(list.length).toBe(2);
  expect(list[0].id).toBe("claude-code");
  expect(list[1].id).toBe("codex");
});
