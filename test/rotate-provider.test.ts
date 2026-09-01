// Provider-side rotation (TODOS.md "Provider-side key rotation").
//
// The rotation module is pure + dependency-injected, so a fake fetch covers
// the full surface offline: project auto-select, minting via service account,
// last-4 matching for the best-effort old-key delete, and — load-bearing —
// that key material never leaks into thrown error messages. Plus the
// audit_log CHECK migration for the new rotate.issued / rotate.failed
// classes, mirroring test/broker-audit.test.ts.

import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { openaiRotationProvider, getRotationProvider } from "../src/providers/openai-rotate.ts";

const ADMIN = "sk-admin-FAKE-test-value-000111222333";
const NEW_KEY = "sk-svcacct-FAKE-minted-value-444555666";
const OLD_KEY = "sk-proj-FAKE-old-value-endswith-ab12";
const FIXED_NOW = () => new Date("2026-09-01T00:00:00Z");

/** Fake fetch: route by method+path substring, record every call. */
function fakeFetch(routes: { match: (url: string, init?: any) => boolean; respond: (url: string, init?: any) => Response }[]) {
  const calls: { url: string; init: any }[] = [];
  const fn = (async (url: string, init?: any) => {
    calls.push({ url: String(url), init });
    for (const r of routes) {
      if (r.match(String(url), init)) return r.respond(String(url), init);
    }
    return new Response(JSON.stringify({ error: "unrouted" }), { status: 500 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const projectsRoute = (projects: { id: string; name?: string }[]) => ({
  match: (u: string, i: any) => u.includes("/projects?") && (i?.method ?? "GET") === "GET",
  respond: () => json({ data: projects }),
});
const mintRoute = () => ({
  match: (u: string, i: any) => u.endsWith("/service_accounts") && i?.method === "POST",
  respond: () => json({ id: "svc_acct_1", api_key: { value: NEW_KEY, id: "key_new" } }),
});
const listKeysRoute = (keys: { id: string; redacted_value?: string }[]) => ({
  match: (u: string, i: any) => u.includes("/api_keys?") && (i?.method ?? "GET") === "GET",
  respond: () => json({ data: keys }),
});
const deleteRoute = (ok = true) => ({
  match: (u: string, i: any) => /\/api_keys\/[^/?]+$/.test(u) && i?.method === "DELETE",
  respond: () => json({ deleted: ok }, ok ? 200 : 500),
});

test("happy path: single project auto-selected, key minted, old key matched by last-4 and deleted", async () => {
  const { fn, calls } = fakeFetch([
    projectsRoute([{ id: "proj_only", name: "Main" }]),
    mintRoute(),
    listKeysRoute([
      { id: "key_other", redacted_value: "sk-...zz99" },
      { id: "key_old", redacted_value: "sk-...ab12" },
    ]),
    deleteRoute(),
  ]);
  const r = await openaiRotationProvider.rotate(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW });
  expect(r.newValue).toBe(NEW_KEY);
  expect(r.projectId).toBe("proj_only");
  expect(r.serviceAccountId).toBe("svc_acct_1");
  expect(r.oldKey).toBe("deleted");
  // The DELETE hit the matched key id, and every call carried the admin key.
  const del = calls.find((c) => c.init?.method === "DELETE")!;
  expect(del.url).toContain("/api_keys/key_old");
  for (const c of calls) {
    expect(c.init?.headers?.["Authorization"]).toBe(`Bearer ${ADMIN}`);
  }
  // The mint body names the rotation, dated by the injected clock.
  const mint = calls.find((c) => c.init?.method === "POST")!;
  expect(String(mint.init.body)).toContain("stm-rotate-2026-09-01");
});

test("explicit --project skips the project listing entirely", async () => {
  const { fn, calls } = fakeFetch([mintRoute(), listKeysRoute([]), deleteRoute()]);
  const r = await openaiRotationProvider.rotate(
    ADMIN,
    { oldValue: OLD_KEY, projectId: "proj_given" },
    { fetch: fn, now: FIXED_NOW },
  );
  expect(r.projectId).toBe("proj_given");
  expect(calls.some((c) => c.url.includes("/projects?"))).toBe(false);
});

test("multiple projects without --project: refuses, lists candidates, never mints", async () => {
  const { fn, calls } = fakeFetch([
    projectsRoute([{ id: "proj_a", name: "Alpha" }, { id: "proj_b", name: "Beta" }]),
  ]);
  await expect(
    openaiRotationProvider.rotate(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW }),
  ).rejects.toThrow(/--project/);
  try {
    await openaiRotationProvider.rotate(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW });
  } catch (e: any) {
    expect(e.message).toContain("proj_a");
    expect(e.message).toContain("proj_b");
  }
  expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
});

test("old key not found by last-4: mint succeeds, oldKey=not-found, no DELETE issued", async () => {
  const { fn, calls } = fakeFetch([
    projectsRoute([{ id: "proj_only" }]),
    mintRoute(),
    listKeysRoute([{ id: "key_other", redacted_value: "sk-...zz99" }]),
  ]);
  const r = await openaiRotationProvider.rotate(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW });
  expect(r.oldKey).toBe("not-found");
  expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
});

test("ambiguous last-4 match: refuses to guess-delete", async () => {
  const { fn, calls } = fakeFetch([
    projectsRoute([{ id: "proj_only" }]),
    mintRoute(),
    listKeysRoute([
      { id: "key_1", redacted_value: "sk-...ab12" },
      { id: "key_2", redacted_value: "sk-live-...ab12" },
    ]),
  ]);
  const r = await openaiRotationProvider.rotate(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW });
  expect(r.oldKey).toBe("ambiguous");
  expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
});

test("old-key delete failure never unwinds the mint", async () => {
  const { fn } = fakeFetch([
    projectsRoute([{ id: "proj_only" }]),
    mintRoute(),
    listKeysRoute([{ id: "key_old", redacted_value: "sk-...ab12" }]),
    deleteRoute(false),
  ]);
  const r = await openaiRotationProvider.rotate(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW });
  expect(r.newValue).toBe(NEW_KEY);
  expect(r.oldKey).toBe("delete-failed");
});

test("no stored old value: deletion skipped", async () => {
  const { fn, calls } = fakeFetch([projectsRoute([{ id: "proj_only" }]), mintRoute()]);
  const r = await openaiRotationProvider.rotate(ADMIN, { oldValue: null }, { fetch: fn, now: FIXED_NOW });
  expect(r.oldKey).toBe("skipped");
  expect(calls.some((c) => c.url.includes("/api_keys"))).toBe(false);
});

test("SECURITY: no thrown error ever contains key material", async () => {
  const attempts: (() => Promise<unknown>)[] = [
    // auth failure on project list
    () => {
      const { fn } = fakeFetch([{ match: () => true, respond: () => json({}, 401) }]);
      return openaiRotationProvider.rotate(ADMIN, { oldValue: OLD_KEY }, { fetch: fn });
    },
    // mint returns a malformed shape that DOES carry a secret-looking field
    () => {
      const { fn } = fakeFetch([
        projectsRoute([{ id: "proj_only" }]),
        {
          match: (u, i) => u.endsWith("/service_accounts") && i?.method === "POST",
          respond: () => json({ oops: NEW_KEY }),
        },
      ]);
      return openaiRotationProvider.rotate(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW });
    },
    // network throw
    () => {
      const fn = (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch;
      return openaiRotationProvider.rotate(ADMIN, { oldValue: OLD_KEY }, { fetch: fn });
    },
  ];
  for (const run of attempts) {
    let msg = "";
    try {
      await run();
      throw new Error("expected rotate to throw");
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg.includes(ADMIN)).toBe(false);
    expect(msg.includes(NEW_KEY)).toBe(false);
    expect(msg.includes(OLD_KEY)).toBe(false);
  }
});

test("registry: openai resolves, unknown tools do not", () => {
  expect(getRotationProvider("openai")).toBe(openaiRotationProvider);
  expect(getRotationProvider("stripe")).toBeNull();
  expect(openaiRotationProvider.adminCredentialLabel).toBe("admin-key");
});

// ---- audit_log CHECK migration for rotate.* (mirrors broker-audit.test.ts) --

const P = process.pid;
const FRESH = join(tmpdir(), `stm-rotateaudit-fresh-${P}.sqlite`);
const OLD_DB = join(tmpdir(), `stm-rotateaudit-old-${P}.sqlite`);

afterAll(() => {
  for (const f of [FRESH, OLD_DB]) {
    for (const s of ["", "-wal", "-shm"]) {
      try { rmSync(f + s); } catch { /* ignore */ }
    }
  }
});

test("fresh DB records rotate.issued and rotate.failed audit events", () => {
  const s = new Store(FRESH);
  s.recordAudit({ event: "rotate.issued", tool: "openai", label: "default", reason: "project=proj_x old-key=deleted" });
  s.recordAudit({ event: "rotate.failed", tool: "openai", label: "default", reason: "auth failed (HTTP 401)" });
  const issued = s.listAudit({ event: "rotate.issued" });
  const failed = s.listAudit({ event: "rotate.failed" });
  s.close();
  expect(issued).toHaveLength(1);
  expect(failed).toHaveLength(1);
  expect(issued[0].reason).toContain("old-key=deleted");
});

test("a pre-rotate DB (broker-era CHECK) is migrated, rows preserved", () => {
  const raw = new Database(OLD_DB);
  raw.exec(`
    CREATE TABLE audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         TEXT NOT NULL,
      event      TEXT NOT NULL CHECK(event IN (
                   'substitute','policy.deny','policy.warn',
                   'unresolved','malformed','broker')),
      tool TEXT, label TEXT, command TEXT, agent TEXT, policy_id INTEGER, reason TEXT
    );
    INSERT INTO audit_log (ts,event,tool,label,command,agent)
      VALUES ('2026-01-01T00:00:00Z','broker','openai','default','GET /v1/models -> 200','broker');
  `);
  expect(() => raw.exec(`INSERT INTO audit_log (ts,event) VALUES ('x','rotate.issued')`)).toThrow();
  raw.close();

  const s = new Store(OLD_DB);
  expect(s.auditCount()).toBe(1); // legacy broker row preserved
  s.recordAudit({ event: "rotate.issued", tool: "openai", label: "default" });
  expect(s.listAudit({ event: "rotate.issued" })).toHaveLength(1);
  s.close();

  // Idempotent on reopen.
  const s2 = new Store(OLD_DB);
  expect(s2.auditCount()).toBe(2);
  s2.close();
});
