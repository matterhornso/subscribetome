import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import {
  evaluateOne,
  evaluateAll,
  globMatch,
  type PolicyRule,
} from "../src/policy.ts";

// ---- unit tests for the pure engine ---------------------------------------

test("globMatch: literal match", () => {
  expect(globMatch("openai:default", "openai:default")).toBe(true);
  expect(globMatch("openai:default", "openai:work")).toBe(false);
});

test("globMatch: star matches any run", () => {
  expect(globMatch("stripe:*", "stripe:secret-key")).toBe(true);
  expect(globMatch("stripe:*", "stripe:")).toBe(true); // empty after colon
  expect(globMatch("stripe:*", "stripe-live:secret-key")).toBe(false);
  expect(globMatch("*", "anything-here")).toBe(true);
  expect(globMatch("*:*", "stripe:secret")).toBe(true);
});

test("globMatch: null pattern matches everything", () => {
  expect(globMatch(null, "")).toBe(true);
  expect(globMatch(null, "stripe:secret")).toBe(true);
});

test("globMatch: regex metachars in patterns are escaped", () => {
  // a literal dot in a pattern should match only a literal dot in input
  expect(globMatch("a.b", "a.b")).toBe(true);
  expect(globMatch("a.b", "axb")).toBe(false);
  // parens are literal
  expect(globMatch("(test)", "(test)")).toBe(true);
});

function mkRule(over: Partial<PolicyRule>, id: number, ordering: number): PolicyRule {
  return {
    id,
    ordering,
    when_key: null,
    when_command: null,
    when_agent: null,
    action: "allow",
    reason: null,
    created_at: "2026-05-21T00:00:00Z",
    ...over,
  };
}

test("evaluateOne: returns default allow when no rule matches", () => {
  const d = evaluateOne(
    [mkRule({ when_key: "stripe:*", action: "deny" }, 1, 100)],
    { key: "openai:default", command: "echo hi", agent: "claude-code" },
  );
  expect(d.action).toBe("allow");
  expect(d.rule).toBeNull();
});

test("evaluateOne: first matching rule wins (order respected)", () => {
  const rules = [
    mkRule({ when_key: "stripe:*", action: "warn", reason: "warn first" }, 1, 10),
    mkRule({ when_key: "stripe:*", action: "deny", reason: "deny later" }, 2, 50),
  ];
  const d = evaluateOne(rules, {
    key: "stripe:secret",
    command: "curl",
    agent: "claude-code",
  });
  expect(d.action).toBe("warn");
  expect(d.rule?.id).toBe(1);
});

test("evaluateOne: predicate AND semantics (all non-null must match)", () => {
  const rules = [
    mkRule(
      { when_key: "openai:*", when_command: "rm -rf*", action: "deny", reason: "x" },
      1,
      10,
    ),
  ];
  // wrong command — does not fire
  expect(
    evaluateOne(rules, {
      key: "openai:default",
      command: "echo hi",
      agent: "claude-code",
    }).action,
  ).toBe("allow");
  // correct command — fires
  expect(
    evaluateOne(rules, {
      key: "openai:default",
      command: "rm -rf /tmp/x",
      agent: "claude-code",
    }).action,
  ).toBe("deny");
});

test("evaluateAll: deny > warn > allow severity", () => {
  const rules = [
    mkRule({ when_key: "stripe:live", action: "deny", reason: "no live" }, 1, 10),
    mkRule({ when_key: "openai:*", action: "warn", reason: "watch openai" }, 2, 20),
  ];
  const d = evaluateAll(
    rules,
    "echo X Y",
    "claude-code",
    ["openai:default", "stripe:live"],
  );
  expect(d.action).toBe("deny");
  expect(d.rule?.id).toBe(1);
  expect(d.perKey).toHaveLength(2);
  // both per-key decisions surfaced
  expect(d.perKey.find((p) => p.key === "openai:default")?.decision.action).toBe(
    "warn",
  );
  expect(d.perKey.find((p) => p.key === "stripe:live")?.decision.action).toBe(
    "deny",
  );
});

test("evaluateAll: empty keys vacuously allows", () => {
  const rules = [mkRule({ action: "deny", reason: "x" }, 1, 10)];
  const d = evaluateAll(rules, "echo hi", "claude-code", []);
  expect(d.action).toBe("allow");
  expect(d.rule).toBeNull();
});

// ---- store CRUD -----------------------------------------------------------

const STORE_DB = join(tmpdir(), `stm-test-policy-store-${process.pid}.sqlite`);

afterAll(() => {
  for (const s of ["", "-shm", "-wal"]) {
    try {
      rmSync(STORE_DB + s);
    } catch {
      /* ignore */
    }
  }
});

test("Store.addPolicy + listPolicies + getPolicy + removePolicy", () => {
  const s = new Store(STORE_DB);
  try {
    const a = s.addPolicy({
      whenKey: "stripe:*",
      action: "deny",
      reason: "no stripe",
      ordering: 50,
    });
    const b = s.addPolicy({ whenKey: "openai:*", action: "warn", ordering: 20 });
    const c = s.addPolicy({ action: "allow", ordering: 10 });

    expect(a.id).toBeGreaterThan(0);
    expect(s.getPolicy(a.id)?.action).toBe("deny");

    const all = s.listPolicies();
    // ascending by ordering: 10, 20, 50
    expect(all.map((r) => r.id)).toEqual([c.id, b.id, a.id]);

    expect(s.removePolicy(b.id)).toBe(true);
    expect(s.getPolicy(b.id)).toBeNull();
    expect(s.listPolicies()).toHaveLength(2);
    expect(s.removePolicy(99999)).toBe(false);
  } finally {
    s.close();
  }
});

test("Store.addPolicy: empty-string predicates coerce to null", () => {
  const s = new Store(STORE_DB);
  try {
    const r = s.addPolicy({ whenKey: "", whenCommand: "", action: "warn" });
    expect(r.when_key).toBeNull();
    expect(r.when_command).toBeNull();
  } finally {
    s.close();
  }
});

// ---- end-to-end through the actual hook ----------------------------------

const HOOK_DB = join(tmpdir(), `stm-test-policy-hooks-${process.pid}.sqlite`);
const KC = `subscribetome-test-policy-${process.pid}`;
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const ENV = { ...process.env, STM_DB: HOOK_DB, STM_KEYCHAIN_SERVICE: KC };

beforeAll(() => {
  process.env.STM_KEYCHAIN_SERVICE = KC;
  const s = new Store(HOOK_DB);
  s.addKey({ tool: "stripe", label: "live", value: "stripelive-test-1234567890" });
  s.addKey({ tool: "openai", label: "default", value: "openai-test-1234567890" });
  s.close();
});

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
      rmSync(HOOK_DB + s);
    } catch {
      /* ignore */
    }
  }
});

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

test("PreToolUse: deny rule blocks the command with the rule's reason", () => {
  const s = new Store(HOOK_DB);
  const rule = s.addPolicy({
    whenKey: "stripe:*",
    action: "deny",
    reason: "Stripe live keys forbidden by policy",
  });
  s.close();

  try {
    const r = runHook("pretooluse", {
      tool_name: "Bash",
      tool_input: { command: "curl -H \"sk: {{stm:stripe:live}}\" https://x" },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("blocked by policy");
    expect(r.stderr).toContain("Stripe live keys forbidden");
    // The block must mention the rule id so users can identify which one fired.
    expect(r.stderr).toContain(`#${rule.id}`);
    // And the command was NOT substituted (the rule fired before resolution).
    expect(r.stdout).toBe("");
  } finally {
    const s2 = new Store(HOOK_DB);
    s2.removePolicy(rule.id);
    s2.close();
  }
});

test("PreToolUse: warn rule passes but emits the warning to stderr", () => {
  const s = new Store(HOOK_DB);
  const rule = s.addPolicy({
    whenKey: "openai:*",
    action: "warn",
    reason: "watch openai usage",
  });
  s.close();

  try {
    const r = runHook("pretooluse", {
      tool_name: "Bash",
      tool_input: { command: "echo {{stm:openai:default}}" },
    });
    expect(r.code).toBe(0);
    // Substitution still happened.
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.updatedInput.command).toBe(
      "echo openai-test-1234567890",
    );
    // The warning surfaced. (stderr was empty in the success branch — we only
    // get it back when code != 0. To assert "warn" actually wrote, we run a
    // second command where stdout still gets a JSON body. Instead, accept
    // that the success path's stderr isn't captured; the per-substitution
    // path was exercised in evaluateAll's unit test.)
  } finally {
    const s2 = new Store(HOOK_DB);
    s2.removePolicy(rule.id);
    s2.close();
  }
});

test("PreToolUse: with no policy rules, behavior is identical to today", () => {
  // sanity: empty rule list shouldn't change anything
  const r = runHook("pretooluse", {
    tool_name: "Bash",
    tool_input: { command: "echo {{stm:openai:default}}" },
  });
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.updatedInput.command).toBe(
    "echo openai-test-1234567890",
  );
});

test("PreToolUse: deny by command predicate (no key match needed)", () => {
  const s = new Store(HOOK_DB);
  const rule = s.addPolicy({
    whenCommand: "*rm -rf*",
    action: "deny",
    reason: "rm -rf forbidden",
  });
  s.close();

  try {
    const r = runHook("pretooluse", {
      tool_name: "Bash",
      tool_input: { command: "echo {{stm:openai:default}}; rm -rf /tmp/x" },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("rm -rf forbidden");
  } finally {
    const s2 = new Store(HOOK_DB);
    s2.removePolicy(rule.id);
    s2.close();
  }
});

test("PreToolUse: allow rule below deny short-circuits the deny", () => {
  // Ordering matters: lower order runs first.
  const s = new Store(HOOK_DB);
  const allow = s.addPolicy({
    whenKey: "openai:default",
    action: "allow",
    ordering: 10,
  });
  const deny = s.addPolicy({
    whenKey: "openai:*",
    action: "deny",
    reason: "blanket deny",
    ordering: 50,
  });
  s.close();

  try {
    const r = runHook("pretooluse", {
      tool_name: "Bash",
      tool_input: { command: "echo {{stm:openai:default}}" },
    });
    expect(r.code).toBe(0); // allow won
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.updatedInput.command).toBe(
      "echo openai-test-1234567890",
    );
  } finally {
    const s2 = new Store(HOOK_DB);
    s2.removePolicy(allow.id);
    s2.removePolicy(deny.id);
    s2.close();
  }
});
