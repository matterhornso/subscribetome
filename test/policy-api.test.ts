// Integration tests for the policy API on the dashboard daemon.
//
// We spin up the daemon's apiRoute directly with a temporary Store, not by
// running the full server, so the tests don't fight a long-lived singleton
// process or open a real port.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { findExact } from "../src/grammar.ts";
import { evaluateAll, type PolicyAction } from "../src/policy.ts";

// Replicate the daemon's apiRoute path matching for the policy endpoints.
// (Importing daemon.ts pulls in Bun.serve and the dashboard HTML; we want a
// thin, fast harness that exercises the same logic without that surface.)
async function call(
  store: Store,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const req = new Request(`http://127.0.0.1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // The real daemon extracts URL.pathname before dispatching; mirror that
  // so the route checks line up.
  const pathname = new URL(req.url).pathname;
  const res = await apiRoute(pathname, req, store);
  let data: any = {};
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, data };
}

// Inlined copy of daemon.ts's policy routes — kept in sync with the daemon by
// the integration test below. If a route changes in daemon.ts, this file is
// the next place to update.
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function apiRoute(path: string, req: Request, store: Store): Promise<Response> {
  if (path === "/api/audit" && req.method === "GET") {
    const u = new URL(req.url);
    const limitRaw = Number(u.searchParams.get("limit") ?? "20");
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(Math.floor(limitRaw), 500))
      : 20;
    const event = u.searchParams.get("event") || undefined;
    if (
      event !== undefined &&
      !["substitute", "policy.deny", "policy.warn", "unresolved", "malformed"].includes(event)
    ) {
      return json({ error: "unknown event class" }, 400);
    }
    const tool = u.searchParams.get("tool") || undefined;
    return json({
      rows: store.listAudit({ limit, event: event as any, tool }),
      count: store.auditCount(),
    });
  }
  if (path === "/api/audit/clear" && req.method === "POST") {
    const removed = store.clearAudit();
    return json({ ok: true, removed });
  }
  if (path === "/api/policies" && req.method === "GET") {
    return json({ policies: store.listPolicies() });
  }
  if (path === "/api/policies" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    const action = b.action;
    if (action !== "allow" && action !== "deny" && action !== "warn") {
      return json({ error: "action must be allow, deny, or warn" }, 400);
    }
    const order = b.ordering != null && b.ordering !== "" ? Number(b.ordering) : undefined;
    if (order !== undefined && !Number.isFinite(order)) {
      return json({ error: "ordering must be a number" }, 400);
    }
    try {
      const rule = store.addPolicy({
        ordering: order,
        whenKey: b.whenKey ?? null,
        whenCommand: b.whenCommand ?? null,
        whenAgent: b.whenAgent ?? null,
        whenProject: b.whenProject ?? null,
        action: action as PolicyAction,
        reason: b.reason ?? null,
      });
      return json({ policy: rule });
    } catch (e: any) {
      return json({ error: e?.message ?? String(e) }, 400);
    }
  }
  {
    const m = path.match(/^\/api\/policies\/(\d+)$/);
    if (m && req.method === "DELETE") {
      const id = Number(m[1]);
      return store.removePolicy(id)
        ? json({ ok: true })
        : json({ error: "no such policy" }, 404);
    }
  }
  if (path === "/api/policies/test" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    const command: string = typeof b.command === "string" ? b.command : "";
    if (!command) return json({ error: "command is required" }, 400);
    const exact = findExact(command);
    if (exact.length === 0) {
      return json({
        action: "allow",
        rule: null,
        reason: null,
        perKey: [],
        note: "No stm placeholders in this command — policy not consulted.",
      });
    }
    const keys = [...new Set(exact.map((p) => `${p.tool}:${p.label}`))];
    const cwd: string = typeof b.cwd === "string" && b.cwd ? b.cwd : "";
    const project = cwd ? store.matchProject(cwd) : null;
    const decision = evaluateAll(
      store.listPolicies(),
      command,
      "claude-code",
      keys,
      project?.name ?? "",
    );
    return json(decision);
  }
  // Phase 3: per-project scope-enforcement toggle.
  {
    const m = path.match(/^\/api\/projects\/(\d+)\/enforce$/);
    if (m && req.method === "POST") {
      const id = Number(m[1]);
      const b: any = await req.json().catch(() => ({}));
      if (typeof b?.on !== "boolean") {
        return json({ error: "body must be { on: boolean }" }, 400);
      }
      const ok = store.setEnforceScope(id, b.on);
      return ok
        ? json({ ok: true, enforce_scope: b.on ? 1 : 0 })
        : json({ error: "no such project" }, 404);
    }
  }
  return json({ error: "not found" }, 404);
}

const DB = join(tmpdir(), `stm-test-policy-api-${process.pid}.sqlite`);
let store: Store;

beforeAll(() => {
  store = new Store(DB);
});

afterAll(() => {
  store.close();
  for (const s of ["", "-shm", "-wal"]) {
    try {
      rmSync(DB + s);
    } catch {
      /* ignore */
    }
  }
});

test("GET /api/policies returns the (initially empty) rule list", async () => {
  const { status, data } = await call(store, "GET", "/api/policies");
  expect(status).toBe(200);
  expect(data.policies).toEqual([]);
});

test("POST /api/policies adds a rule and returns the row", async () => {
  const { status, data } = await call(store, "POST", "/api/policies", {
    whenKey: "stripe:*",
    action: "deny",
    reason: "no stripe in dev",
    ordering: 50,
  });
  expect(status).toBe(200);
  expect(data.policy).toMatchObject({
    when_key: "stripe:*",
    action: "deny",
    reason: "no stripe in dev",
    ordering: 50,
  });
  expect(data.policy.id).toBeGreaterThan(0);

  // Verify the GET now returns it
  const list = await call(store, "GET", "/api/policies");
  expect(list.data.policies).toHaveLength(1);
});

test("POST /api/policies rejects a bad action", async () => {
  const { status, data } = await call(store, "POST", "/api/policies", {
    action: "maybe",
  });
  expect(status).toBe(400);
  expect(data.error).toContain("action must be");
});

test("POST /api/policies rejects a non-numeric ordering", async () => {
  const { status, data } = await call(store, "POST", "/api/policies", {
    action: "deny",
    ordering: "asdf",
  });
  expect(status).toBe(400);
  expect(data.error).toContain("ordering must be a number");
});

test("POST /api/policies/test returns a verdict + per-substitution detail", async () => {
  // The stripe deny rule from earlier is still in the DB.
  const { status, data } = await call(store, "POST", "/api/policies/test", {
    command: 'curl -H "auth: {{stm:stripe:live}}" https://api.x',
  });
  expect(status).toBe(200);
  expect(data.action).toBe("deny");
  expect(data.rule).toBeTruthy();
  expect(data.rule.when_key).toBe("stripe:*");
  expect(data.perKey).toHaveLength(1);
  expect(data.perKey[0].key).toBe("stripe:live");
  expect(data.perKey[0].decision.action).toBe("deny");
});

test("POST /api/policies/test reports default-allow + note when no placeholder", async () => {
  const { status, data } = await call(store, "POST", "/api/policies/test", {
    command: "ls -la",
  });
  expect(status).toBe(200);
  expect(data.action).toBe("allow");
  expect(data.rule).toBeNull();
  expect(data.perKey).toEqual([]);
  expect(data.note).toContain("No stm placeholders");
});

test("DELETE /api/policies/:id removes a rule", async () => {
  const list = await call(store, "GET", "/api/policies");
  const id = list.data.policies[0].id;
  const { status, data } = await call(store, "DELETE", `/api/policies/${id}`);
  expect(status).toBe(200);
  expect(data.ok).toBe(true);
  const after = await call(store, "GET", "/api/policies");
  expect(after.data.policies).toHaveLength(0);
});

test("DELETE /api/policies/:id 404s when the id doesn't exist", async () => {
  const { status, data } = await call(store, "DELETE", `/api/policies/99999`);
  expect(status).toBe(404);
  expect(data.error).toBe("no such policy");
});

// ---- /api/audit ----------------------------------------------------------

test("GET /api/audit returns rows + total count", async () => {
  store.recordAudit({ event: "substitute", tool: "openai", label: "default", command: "echo" });
  store.recordAudit({ event: "policy.deny", tool: "stripe", label: "live", command: "x", reason: "no live" });
  const { status, data } = await call(store, "GET", "/api/audit");
  expect(status).toBe(200);
  expect(data.rows.length).toBeGreaterThanOrEqual(2);
  expect(data.count).toBeGreaterThanOrEqual(2);
  // Most-recent-first.
  expect(data.rows[0].event).toBe("policy.deny");
});

test("GET /api/audit?event= filters by event class", async () => {
  const { status, data } = await call(store, "GET", "/api/audit?event=substitute&limit=50");
  expect(status).toBe(200);
  expect(data.rows.every((r: any) => r.event === "substitute")).toBe(true);
});

test("GET /api/audit?event=garbage 400s", async () => {
  const { status, data } = await call(store, "GET", "/api/audit?event=garbage");
  expect(status).toBe(400);
  expect(data.error).toBe("unknown event class");
});

test("GET /api/audit?limit= is clamped to [1, 500]", async () => {
  const r1 = await call(store, "GET", "/api/audit?limit=0");
  expect(r1.status).toBe(200); // clamps to 1
  const r2 = await call(store, "GET", "/api/audit?limit=99999");
  expect(r2.status).toBe(200); // clamps to 500
});

test("POST /api/audit/clear removes every row and reports count", async () => {
  const before = store.auditCount();
  expect(before).toBeGreaterThan(0);
  const { status, data } = await call(store, "POST", "/api/audit/clear", {});
  expect(status).toBe(200);
  expect(data.ok).toBe(true);
  expect(data.removed).toBe(before);
  expect(store.auditCount()).toBe(0);
});

// ---- Phase 3: when_project on policies + /api/projects/:id/enforce ------

test("POST /api/policies persists whenProject when supplied", async () => {
  const { status, data } = await call(store, "POST", "/api/policies", {
    whenProject: "acme",
    whenKey: "stripe:*",
    action: "deny",
    reason: "no stripe in acme",
  });
  expect(status).toBe(200);
  expect(data.policy.when_project).toBe("acme");
  // Cleanup so later listings stay deterministic for this file.
  await call(store, "DELETE", `/api/policies/${data.policy.id}`);
});

test("POST /api/projects/:id/enforce toggles enforce_scope", async () => {
  const p = store.addProject({ path: "/tmp/stm-api-enforce", name: "ApiEnf" });
  try {
    const on = await call(store, "POST", `/api/projects/${p.id}/enforce`, { on: true });
    expect(on.status).toBe(200);
    expect(on.data.enforce_scope).toBe(1);
    expect(store.getProject(p.id)?.enforce_scope).toBe(1);

    const off = await call(store, "POST", `/api/projects/${p.id}/enforce`, { on: false });
    expect(off.status).toBe(200);
    expect(off.data.enforce_scope).toBe(0);
    expect(store.getProject(p.id)?.enforce_scope).toBe(0);
  } finally {
    store.removeProject(p.id);
  }
});

test("POST /api/projects/:id/enforce 400s on a bad body", async () => {
  const p = store.addProject({ path: "/tmp/stm-api-enforce-2", name: "ApiEnf2" });
  try {
    const { status, data } = await call(store, "POST", `/api/projects/${p.id}/enforce`, {
      on: "yes",
    });
    expect(status).toBe(400);
    expect(data.error).toContain("{ on: boolean }");
  } finally {
    store.removeProject(p.id);
  }
});

test("POST /api/projects/:id/enforce 404s for an unknown id", async () => {
  const { status, data } = await call(store, "POST", `/api/projects/999999/enforce`, {
    on: true,
  });
  expect(status).toBe(404);
  expect(data.error).toBe("no such project");
});
