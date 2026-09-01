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
  const m = await openaiRotationProvider.mint(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW });
  expect(m.newValue).toBe(NEW_KEY);
  expect(m.projectId).toBe("proj_only");
  expect(m.serviceAccountId).toBe("svc_acct_1");
  const outcome = await openaiRotationProvider.retire(ADMIN, { projectId: m.projectId, oldValue: OLD_KEY }, { fetch: fn });
  expect(outcome).toBe("deleted");
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
  const r = await openaiRotationProvider.mint(
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
    openaiRotationProvider.mint(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW }),
  ).rejects.toThrow(/--project/);
  try {
    await openaiRotationProvider.mint(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW });
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
  const m = await openaiRotationProvider.mint(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW });
  const r = await openaiRotationProvider.retire(ADMIN, { projectId: m.projectId, oldValue: OLD_KEY }, { fetch: fn });
  expect(r).toBe("not-found");
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
  const m = await openaiRotationProvider.mint(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW });
  const r = await openaiRotationProvider.retire(ADMIN, { projectId: m.projectId, oldValue: OLD_KEY }, { fetch: fn });
  expect(r).toBe("ambiguous");
  expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
});

test("old-key delete failure never unwinds the mint", async () => {
  const { fn } = fakeFetch([
    projectsRoute([{ id: "proj_only" }]),
    mintRoute(),
    listKeysRoute([{ id: "key_old", redacted_value: "sk-...ab12" }]),
    deleteRoute(false),
  ]);
  const m = await openaiRotationProvider.mint(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW });
  expect(m.newValue).toBe(NEW_KEY);
  const r = await openaiRotationProvider.retire(ADMIN, { projectId: m.projectId, oldValue: OLD_KEY }, { fetch: fn });
  expect(r).toBe("delete-failed");
});

test("no stored old value: deletion skipped", async () => {
  const { fn, calls } = fakeFetch([projectsRoute([{ id: "proj_only" }]), mintRoute()]);
  const m = await openaiRotationProvider.mint(ADMIN, { oldValue: null }, { fetch: fn, now: FIXED_NOW });
  const r = await openaiRotationProvider.retire(ADMIN, { projectId: m.projectId, oldValue: null }, { fetch: fn });
  expect(r).toBe("skipped");
  expect(calls.some((c) => c.url.includes("/api_keys"))).toBe(false);
});

test("SECURITY: no thrown error ever contains key material", async () => {
  const attempts: (() => Promise<unknown>)[] = [
    // auth failure on project list
    () => {
      const { fn } = fakeFetch([{ match: () => true, respond: () => json({}, 401) }]);
      return openaiRotationProvider.mint(ADMIN, { oldValue: OLD_KEY }, { fetch: fn });
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
      return openaiRotationProvider.mint(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW });
    },
    // network throw
    () => {
      const fn = (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch;
      return openaiRotationProvider.mint(ADMIN, { oldValue: OLD_KEY }, { fetch: fn });
    },
  ];
  for (const run of attempts) {
    let msg = "";
    try {
      await run();
      throw new Error("expected mint to throw");
    } catch (e: any) {
      msg = String(e?.message ?? e);
    }
    expect(msg.includes(ADMIN)).toBe(false);
    expect(msg.includes(NEW_KEY)).toBe(false);
    expect(msg.includes(OLD_KEY)).toBe(false);
  }
});

test("DURABILITY: retire never throws, whatever the network does", async () => {
  // The CLI runs retire AFTER the minted value is already in the keychain, so
  // a throw here would surface as a failure on an already-successful rotation.
  // Every failure mode must degrade to a reported outcome instead.
  const throwingFetch = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof fetch;
  await expect(
    openaiRotationProvider.retire(ADMIN, { projectId: "proj_x", oldValue: OLD_KEY }, { fetch: throwingFetch }),
  ).resolves.toBe("delete-failed");

  const { fn: err500 } = fakeFetch([{ match: () => true, respond: () => json({}, 500) }]);
  await expect(
    openaiRotationProvider.retire(ADMIN, { projectId: "proj_x", oldValue: OLD_KEY }, { fetch: err500 }),
  ).resolves.toBe("delete-failed");

  const { fn: garbage } = fakeFetch([
    { match: () => true, respond: () => new Response("<html>not json</html>", { status: 200 }) },
  ]);
  await expect(
    openaiRotationProvider.retire(ADMIN, { projectId: "proj_x", oldValue: OLD_KEY }, { fetch: garbage }),
  ).resolves.toBe("delete-failed");

  // A missing admin key or missing old value degrades to "skipped", no calls.
  await expect(
    openaiRotationProvider.retire("", { projectId: "proj_x", oldValue: OLD_KEY }),
  ).resolves.toBe("skipped");
});

test("DURABILITY: mint issues no destructive call, so a mint failure changes nothing", async () => {
  // Mint must never DELETE. If minting fails the user's existing key has to
  // still be intact — that is what lets the CLI say "nothing was changed".
  const { fn, calls } = fakeFetch([
    projectsRoute([{ id: "proj_only" }]),
    { match: (u, i) => u.endsWith("/service_accounts") && i?.method === "POST", respond: () => json({}, 500) },
  ]);
  await expect(
    openaiRotationProvider.mint(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW }),
  ).rejects.toThrow();
  expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
});

// ---- preflight (--dry-run) ------------------------------------------------

test("preflight reports the plan and issues NO destructive call", async () => {
  const { fn, calls } = fakeFetch([
    projectsRoute([{ id: "proj_only", name: "Main" }]),
    mintRoute(), // present but must NOT be hit
    listKeysRoute([
      { id: "key_other", redacted_value: "sk-...zz99" },
      { id: "key_old", redacted_value: "sk-...ab12" },
    ]),
    deleteRoute(), // present but must NOT be hit
  ]);
  const pf = await openaiRotationProvider.preflight(ADMIN, { oldValue: OLD_KEY }, { fetch: fn });
  expect(pf.projectId).toBe("proj_only");
  expect(pf.projectCount).toBe(1);
  expect(pf.keyCount).toBe(2);
  expect(pf.oldKeyMatch).toBe("would-delete");
  expect(pf.matchedKeyId).toBe("key_old");
  // The whole point: read-only.
  expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
  expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
});

test("preflight surfaces an ambiguous match without acting", async () => {
  const { fn, calls } = fakeFetch([
    projectsRoute([{ id: "proj_only" }]),
    listKeysRoute([
      { id: "key_1", redacted_value: "sk-...ab12" },
      { id: "key_2", redacted_value: "sk-live-...ab12" },
    ]),
  ]);
  const pf = await openaiRotationProvider.preflight(ADMIN, { oldValue: OLD_KEY }, { fetch: fn });
  expect(pf.oldKeyMatch).toBe("ambiguous");
  expect(pf.matchedKeyId).toBeUndefined();
  expect(calls.some((c) => c.init?.method === "DELETE")).toBe(false);
});

test("preflight fails the same way a real run would on bad auth", async () => {
  const { fn } = fakeFetch([{ match: () => true, respond: () => json({}, 401) }]);
  await expect(
    openaiRotationProvider.preflight(ADMIN, { oldValue: OLD_KEY }, { fetch: fn }),
  ).rejects.toThrow(/auth failed/);
});

test("preflight and mint resolve the SAME project (shared resolver)", async () => {
  // If these drifted, a dry run would rehearse against a different project
  // than the real run touches — worse than no dry run at all.
  const routes = [projectsRoute([{ id: "proj_shared" }]), mintRoute(), listKeysRoute([])];
  const a = await openaiRotationProvider.preflight(ADMIN, { oldValue: OLD_KEY }, { fetch: fakeFetch(routes).fn });
  const b = await openaiRotationProvider.mint(ADMIN, { oldValue: OLD_KEY }, { fetch: fakeFetch(routes).fn, now: FIXED_NOW });
  expect(a.projectId).toBe(b.projectId);

  // And both refuse identically when the project is ambiguous.
  const multi = [projectsRoute([{ id: "p_a" }, { id: "p_b" }])];
  await expect(
    openaiRotationProvider.preflight(ADMIN, { oldValue: OLD_KEY }, { fetch: fakeFetch(multi).fn }),
  ).rejects.toThrow(/--project/);
  await expect(
    openaiRotationProvider.mint(ADMIN, { oldValue: OLD_KEY }, { fetch: fakeFetch(multi).fn, now: FIXED_NOW }),
  ).rejects.toThrow(/--project/);
});

// ---- provider-controlled text hardening -----------------------------------

test("SECURITY: hostile project names cannot inject control chars into errors", async () => {
  // Project names are attacker-influenceable and this error text can be
  // persisted in audit_log.reason, which `stm audit` prints back into the
  // agent's context. ANSI escapes and newlines must not survive.
  const { fn } = fakeFetch([
    projectsRoute([
      { id: "proj_a", name: "ok" },
      { id: "proj_b", name: "evil[31m\nrotate.issued  FORGED LOG LINE" },
    ]),
  ]);
  let msg = "";
  try {
    await openaiRotationProvider.mint(ADMIN, { oldValue: OLD_KEY }, { fetch: fn, now: FIXED_NOW });
  } catch (e: any) {
    msg = String(e.message);
  }
  expect(msg).toContain("proj_b");
  expect(msg).not.toContain(""); // no ANSI escape
  expect(msg).not.toContain(""); // no bell
  expect(msg).not.toContain("FORGED LOG LINE");
  // The only newlines are the ones we put between candidate lines: the
  // injected name must not have added its own.
  expect(msg.split("\n").length).toBe(3); // header + 2 projects
});

test("SECURITY: hostile ids are sanitized before they reach printed results", async () => {
  const { fn } = fakeFetch([
    { match: (u, i) => u.endsWith("/service_accounts") && i?.method === "POST",
      respond: () => json({ id: "svc[2Jclear", api_key: { value: NEW_KEY } }) },
  ]);
  const m = await openaiRotationProvider.mint(
    ADMIN,
    { oldValue: OLD_KEY, projectId: "proj_x" },
    { fetch: fn, now: FIXED_NOW },
  );
  expect(m.serviceAccountId).not.toContain("");
  expect(m.newValue).toBe(NEW_KEY); // the key itself is untouched
});

test("path segments are URL-encoded so a crafted id can't reach another endpoint", async () => {
  const { fn, calls } = fakeFetch([
    listKeysRoute([{ id: "key_old", redacted_value: "sk-...ab12" }]),
    deleteRoute(),
  ]);
  await openaiRotationProvider.retire(
    ADMIN,
    { projectId: "../../evil", oldValue: OLD_KEY },
    { fetch: fn },
  );
  for (const c of calls) {
    expect(c.url.startsWith("https://api.openai.com/v1/organization/")).toBe(true);
    expect(c.url).not.toContain("../");
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
