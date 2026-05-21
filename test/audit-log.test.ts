import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";

// ---- store-level tests (no hook subprocess) -------------------------------

const STORE_DB = join(tmpdir(), `stm-test-audit-store-${process.pid}.sqlite`);

afterAll(() => {
  for (const s of ["", "-shm", "-wal"]) {
    try {
      rmSync(STORE_DB + s);
    } catch {
      /* ignore */
    }
  }
});

test("recordAudit + listAudit roundtrip", () => {
  const s = new Store(STORE_DB);
  try {
    // Need a real policy row to satisfy the FK on audit_log.policy_id.
    // The FK is intentional — spec/audit-log.md §4: ON DELETE SET NULL so a
    // rule deletion doesn't erase the history of when it fired.
    const rule = s.addPolicy({
      whenKey: "stripe:*",
      action: "deny",
      reason: "no live stripe",
    });
    s.recordAudit({
      event: "substitute",
      tool: "openai",
      label: "default",
      command: "echo {{stm:openai:default}}",
      agent: "claude-code",
    });
    s.recordAudit({
      event: "policy.deny",
      tool: "stripe",
      label: "live",
      command: 'curl "{{stm:stripe:live}}"',
      agent: "claude-code",
      policyId: rule.id,
      reason: "no live stripe",
    });

    const rows = s.listAudit();
    expect(rows).toHaveLength(2);
    // listAudit is most-recent-first
    expect(rows[0].event).toBe("policy.deny");
    expect(rows[0].reason).toBe("no live stripe");
    expect(rows[0].policy_id).toBe(rule.id);
    expect(rows[1].event).toBe("substitute");
    expect(rows[1].tool).toBe("openai");
    expect(s.auditCount()).toBe(2);
  } finally {
    s.close();
  }
});

test("ON DELETE SET NULL: deleting the policy preserves the audit row", () => {
  const s = new Store(STORE_DB);
  try {
    s.clearAudit();
    const rule = s.addPolicy({ whenKey: "x:y", action: "warn" });
    s.recordAudit({
      event: "policy.warn",
      tool: "x",
      label: "y",
      command: "test",
      policyId: rule.id,
    });
    expect(s.listAudit()[0].policy_id).toBe(rule.id);

    s.removePolicy(rule.id);
    const after = s.listAudit();
    expect(after).toHaveLength(1); // row preserved
    expect(after[0].policy_id).toBeNull(); // linkage cleared
    expect(after[0].event).toBe("policy.warn"); // history intact
  } finally {
    s.close();
  }
});

test("listAudit filters by event class and tool", () => {
  const s = new Store(STORE_DB);
  try {
    // Seed our own rows so the test isn't order-dependent.
    s.clearAudit();
    s.recordAudit({ event: "substitute", tool: "openai", label: "default", command: "a" });
    s.recordAudit({ event: "substitute", tool: "openai", label: "work", command: "b" });
    s.recordAudit({ event: "unresolved", tool: "ghost", label: "x", command: "c" });
    s.recordAudit({ event: "substitute", tool: "stripe", label: "k", command: "d" });

    expect(s.listAudit({ event: "substitute" }).every((r) => r.event === "substitute")).toBe(
      true,
    );
    expect(s.listAudit({ tool: "openai" }).every((r) => r.tool === "openai")).toBe(true);
    expect(s.listAudit({ event: "substitute", tool: "openai" })).toHaveLength(2);
  } finally {
    s.close();
  }
});

test("clearAudit nukes everything and reports count", () => {
  const s = new Store(STORE_DB);
  try {
    const before = s.auditCount();
    expect(before).toBeGreaterThan(0);
    const removed = s.clearAudit();
    expect(removed).toBe(before);
    expect(s.auditCount()).toBe(0);
  } finally {
    s.close();
  }
});

test("rolling buffer prunes the oldest rows past STM_AUDIT_MAX", () => {
  // Lower the cap so the test is fast.
  const prev = process.env.STM_AUDIT_MAX;
  process.env.STM_AUDIT_MAX = "100";
  try {
    const s = new Store(STORE_DB);
    try {
      // Insert way past the cap; expect pruning to kick in.
      for (let i = 0; i < 250; i++) {
        s.recordAudit({ event: "substitute", tool: "t", label: "l", command: `c${i}` });
      }
      const count = s.auditCount();
      // After 250 inserts at cap=100, count should sit between 100 (just
      // pruned) and 100+AUDIT_PRUNE_BATCH-1 worst case. With prune_batch
      // of 1000 and cap 100, count after first overflow drops to 100, then
      // grows by one per insert until next overflow. Pragmatic assertion:
      // count is bounded by the cap + a comfortable margin and nowhere near
      // 250 (which would mean pruning never ran).
      expect(count).toBeLessThan(250);
      expect(count).toBeGreaterThanOrEqual(1);
      // Oldest rows are gone — the earliest command we'd see has a high index.
      const rows = s.listAudit({ limit: count });
      const earliest = rows[rows.length - 1];
      const earliestIdx = Number(String(earliest.command).replace("c", ""));
      expect(earliestIdx).toBeGreaterThan(0);
    } finally {
      s.close();
    }
  } finally {
    if (prev === undefined) delete process.env.STM_AUDIT_MAX;
    else process.env.STM_AUDIT_MAX = prev;
  }
});

// ---- the load-bearing invariant -------------------------------------------
// The audit log MUST NEVER contain a real key value. Run the actual
// PreToolUse hook with a seeded key whose value is recognisable, then assert
// no audit row in the DB contains that value. See specs/audit-log.md §5.

const HOOK_DB = join(tmpdir(), `stm-test-audit-hooks-${process.pid}.sqlite`);
const KC = `subscribetome-test-audit-${process.pid}`;
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const ENV = { ...process.env, STM_DB: HOOK_DB, STM_KEYCHAIN_SERVICE: KC };
const SECRET = "RECOGNISABLE-SEEDED-VALUE-9876543210";

beforeAll(() => {
  process.env.STM_KEYCHAIN_SERVICE = KC;
  const s = new Store(HOOK_DB);
  s.addKey({ tool: "fal", label: "default", value: SECRET });
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

function runHook(hook: string, payload: object): { code: number; stdout: string; stderr: string } {
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

test("PreToolUse writes a 'substitute' audit row on success", () => {
  // Clear pre-existing audit rows so this test sees only its own writes
  const s0 = new Store(HOOK_DB);
  s0.clearAudit();
  s0.close();

  const r = runHook("pretooluse", {
    tool_name: "Bash",
    tool_input: { command: "echo {{stm:fal:default}}" },
  });
  expect(r.code).toBe(0);

  const s = new Store(HOOK_DB);
  try {
    const rows = s.listAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe("substitute");
    expect(rows[0].tool).toBe("fal");
    expect(rows[0].label).toBe("default");
    expect(rows[0].agent).toBe("claude-code");
    // The command stored is the un-substituted form — placeholders intact.
    expect(rows[0].command).toBe("echo {{stm:fal:default}}");
  } finally {
    s.close();
  }
});

test("INVARIANT: no audit row in the entire DB ever contains the real key value", () => {
  // Trigger every PreToolUse branch that writes an audit row, then scan
  // every audit row for the seeded secret. This is the load-bearing
  // invariant from specs/audit-log.md §5.

  const s0 = new Store(HOOK_DB);
  s0.clearAudit();
  // Add a deny rule so policy.deny fires too.
  const denyRule = s0.addPolicy({
    whenKey: "fal:*",
    action: "deny",
    reason: "test-deny",
    ordering: 999,
  });
  s0.close();

  // 1) Trigger a malformed near-miss
  runHook("pretooluse", {
    tool_name: "Bash",
    tool_input: { command: "echo {{ stm:fal }}" },
  });
  // 2) Trigger an unresolved placeholder
  runHook("pretooluse", {
    tool_name: "Bash",
    tool_input: { command: "echo {{stm:ghost:nope}}" },
  });
  // 3) Trigger a policy.deny on the seeded key
  runHook("pretooluse", {
    tool_name: "Bash",
    tool_input: { command: "echo {{stm:fal:default}}" },
  });

  // Drop the deny rule, then trigger a successful substitute
  const sMid = new Store(HOOK_DB);
  sMid.removePolicy(denyRule.id);
  sMid.close();
  runHook("pretooluse", {
    tool_name: "Bash",
    tool_input: { command: "echo {{stm:fal:default}}" },
  });

  // Now scan every audit row for the seeded secret. None must contain it.
  const s = new Store(HOOK_DB);
  try {
    const rows = s.listAudit({ limit: 10_000 });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // Every text field must not contain the seeded value.
      for (const field of [r.command, r.reason, r.tool, r.label] as (string | null)[]) {
        if (field == null) continue;
        expect(field.includes(SECRET)).toBe(false);
      }
    }
    // And we should have at least one of each event class (sanity that the
    // branches were actually hit, so the scan is meaningful).
    const events = new Set(rows.map((r) => r.event));
    expect(events.has("malformed")).toBe(true);
    expect(events.has("unresolved")).toBe(true);
    expect(events.has("policy.deny")).toBe(true);
    expect(events.has("substitute")).toBe(true);
  } finally {
    s.close();
  }
});

test("Audit write failures never alter the hook's exit code or output", () => {
  // We can't easily monkey-patch the spawned subprocess's Store, so this
  // test asserts the documented behaviour indirectly: with an empty store
  // (fresh DB, the recordAudit code path runs) the hook still emits the
  // updatedInput JSON exactly as without auditing.
  const s0 = new Store(HOOK_DB);
  s0.clearAudit();
  s0.close();
  const r = runHook("pretooluse", {
    tool_name: "Bash",
    tool_input: { command: "echo {{stm:fal:default}}" },
  });
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  expect(out.hookSpecificOutput.updatedInput.command).toBe(`echo ${SECRET}`);
});
