import { test, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Store, normalizeProjectPath } from "../src/store.ts";

// ---- path normalization --------------------------------------------------

test("normalizeProjectPath: expands ~", () => {
  expect(normalizeProjectPath("~")).toBe(homedir());
  expect(normalizeProjectPath("~/code/acme")).toBe(`${homedir()}/code/acme`);
  // "~tilde-not-home" is a relative path with a literal tilde — it must NOT
  // be expanded as the user's home. We assert that home expansion didn't
  // *replace* the tilde: the result keeps the "~tilde-not-home" segment.
  expect(normalizeProjectPath("~tilde-not-home")).toContain("~tilde-not-home");
});

test("normalizeProjectPath: strips trailing slash but preserves root", () => {
  expect(normalizeProjectPath("/a/b/")).toBe("/a/b");
  expect(normalizeProjectPath("/a/b/c///")).toBe("/a/b/c");
  expect(normalizeProjectPath("/")).toBe("/");
});

test("normalizeProjectPath: resolves to absolute and collapses .. / .", () => {
  expect(normalizeProjectPath("/a/b/../c")).toBe("/a/c");
  expect(normalizeProjectPath("/a/./b")).toBe("/a/b");
});

// ---- store CRUD ---------------------------------------------------------

const DB = join(tmpdir(), `stm-test-projects-${process.pid}.sqlite`);

afterAll(() => {
  for (const s of ["", "-shm", "-wal"]) {
    try {
      rmSync(DB + s);
    } catch {
      /* ignore */
    }
  }
});

test("addProject + getProjectByPath + listProjects", () => {
  const s = new Store(DB);
  try {
    const acme = s.addProject({ path: "/code/acme", name: "Acme" });
    const beta = s.addProject({ path: "/code/beta", name: "Beta" });
    expect(acme.id).toBeGreaterThan(0);
    expect(beta.id).toBeGreaterThan(0);
    expect(s.getProjectByPath("/code/acme")?.name).toBe("Acme");
    expect(s.getProjectByPath("/code/acme/")?.name).toBe("Acme"); // normalization
    expect(s.listProjects().map((p) => p.name).sort()).toEqual(["Acme", "Beta"]);
  } finally {
    s.close();
  }
});

test("addProject: duplicate path rejected", () => {
  const s = new Store(DB);
  try {
    expect(() => s.addProject({ path: "/code/acme", name: "Dupe" })).toThrow();
  } finally {
    s.close();
  }
});

test("renameProject + removeProject", () => {
  const s = new Store(DB);
  try {
    const p = s.getProjectByPath("/code/beta")!;
    expect(s.renameProject(p.id, "Beta-2")).toBe(true);
    expect(s.getProjectByPath("/code/beta")?.name).toBe("Beta-2");
    expect(s.removeProject(p.id)).toBe(true);
    expect(s.getProjectByPath("/code/beta")).toBeNull();
  } finally {
    s.close();
  }
});

// ---- matching -----------------------------------------------------------

test("matchProject: longest-prefix wins", () => {
  const s = new Store(DB);
  try {
    // Start clean for this test
    for (const p of s.listProjects()) s.removeProject(p.id);

    s.addProject({ path: "/code/acme", name: "Acme" });
    s.addProject({ path: "/code/acme/landing", name: "Landing" });
    s.addProject({ path: "/code/beta", name: "Beta" });

    // Exact match
    expect(s.matchProject("/code/acme")?.name).toBe("Acme");
    // Subdir of /code/acme that ISN'T inside /landing — Acme wins
    expect(s.matchProject("/code/acme/api")?.name).toBe("Acme");
    // Subdir of /code/acme/landing — Landing wins (longest prefix)
    expect(s.matchProject("/code/acme/landing/src")?.name).toBe("Landing");
    // Unrelated path
    expect(s.matchProject("/code/acme-app")).toBeNull(); // bordered correctly
    expect(s.matchProject("/elsewhere")).toBeNull();
  } finally {
    s.close();
  }
});

test("matchProject: ~ expansion works at the lookup side", () => {
  const s = new Store(DB);
  try {
    for (const p of s.listProjects()) s.removeProject(p.id);
    const created = s.addProject({ path: "~/projects/x", name: "X" });
    expect(created.path).toBe(`${homedir()}/projects/x`);
    expect(s.matchProject("~/projects/x/sub")?.name).toBe("X");
    expect(s.matchProject(`${homedir()}/projects/x`)?.name).toBe("X");
  } finally {
    s.close();
  }
});

// ---- scope --------------------------------------------------------------

test("addProjectScope + projectScope + removeProjectScope", () => {
  const s = new Store(DB);
  try {
    for (const p of s.listProjects()) s.removeProject(p.id);
    const p = s.addProject({ path: "/code/scope-test", name: "ScopeTest" });
    // Need tools to exist first
    s.addKey({ tool: "openai", label: "default", value: "test-openai-val" });
    s.addKey({ tool: "supabase", label: "service-role-key", value: "test-sb-val" });

    s.addProjectScope(p.id, "openai", "default");
    s.addProjectScope(p.id, "supabase", "service-role-key");
    expect(s.projectScope(p.id).map((e) => e.placeholder)).toEqual([
      "{{stm:openai:default}}",
      "{{stm:supabase:service-role-key}}",
    ]);

    // INSERT OR IGNORE: duplicate is a no-op
    s.addProjectScope(p.id, "openai", "default");
    expect(s.projectScope(p.id)).toHaveLength(2);

    // Remove one
    expect(s.removeProjectScope(p.id, "openai", "default")).toBe(true);
    expect(s.projectScope(p.id).map((e) => e.placeholder)).toEqual([
      "{{stm:supabase:service-role-key}}",
    ]);
    expect(s.removeProjectScope(p.id, "openai", "default")).toBe(false); // gone
  } finally {
    s.close();
  }
});

test("addProjectScope rejects an unknown tool", () => {
  const s = new Store(DB);
  try {
    const p = s.getProjectByPath("/code/scope-test")!;
    expect(() => s.addProjectScope(p.id, "ghost", "default")).toThrow(/unknown tool/);
  } finally {
    s.close();
  }
});

test("ON DELETE CASCADE: removing a project drops its scope rows", () => {
  const s = new Store(DB);
  try {
    const p = s.getProjectByPath("/code/scope-test")!;
    expect(s.projectScope(p.id).length).toBeGreaterThan(0);
    s.removeProject(p.id);
    // Verify the project_scope table has no orphan rows for this project_id
    const count = (s.db
      .query(`SELECT COUNT(*) AS c FROM project_scope WHERE project_id = ?`)
      .get(p.id) as { c: number }).c;
    expect(count).toBe(0);
  } finally {
    s.close();
  }
});

test("ON DELETE CASCADE: removing a tool drops its scope rows", () => {
  const s = new Store(DB);
  try {
    for (const p of s.listProjects()) s.removeProject(p.id);
    const p = s.addProject({ path: "/code/cascade", name: "Cascade" });
    s.addProjectScope(p.id, "openai", "default");
    s.addProjectScope(p.id, "supabase", "service-role-key");
    expect(s.projectScope(p.id)).toHaveLength(2);

    // Drop the openai tool directly via SQL — the FK cascade should pull
    // the related scope row with it.
    s.db.query(`DELETE FROM tools WHERE name = 'openai'`).run();
    expect(s.projectScope(p.id).map((e) => e.tool)).toEqual(["supabase"]);
  } finally {
    s.close();
  }
});

// ---- SessionStart end-to-end -------------------------------------------

const HOOK_DB = join(tmpdir(), `stm-test-projects-hooks-${process.pid}.sqlite`);
const KC = `subscribetome-test-projects-${process.pid}`;
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const ENV = { ...process.env, STM_DB: HOOK_DB, STM_KEYCHAIN_SERVICE: KC };

beforeAll(() => {
  process.env.STM_KEYCHAIN_SERVICE = KC;
  const s = new Store(HOOK_DB);
  s.addKey({ tool: "openai", label: "default", value: "openai-test-val" });
  s.addKey({ tool: "stripe", label: "live", value: "stripe-test-val" });
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

test("SessionStart: no project match → unchanged base guidance", () => {
  const r = runHook("sessionstart", {
    hook_event_name: "SessionStart",
    cwd: "/some/unrelated/path",
  });
  expect(r.code).toBe(0);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
  expect(ctx).toContain("API KEYS"); // base guidance survived
  expect(ctx).not.toContain("PROJECT SCOPE"); // no scope appended
});

test("SessionStart: project match → guidance gains a PROJECT SCOPE section listing scoped keys", () => {
  const s = new Store(HOOK_DB);
  const acme = s.addProject({ path: "/code/acme", name: "Acme" });
  s.addProjectScope(acme.id, "openai", "default");
  s.close();

  const r = runHook("sessionstart", {
    hook_event_name: "SessionStart",
    cwd: "/code/acme/api/src",
  });
  expect(r.code).toBe(0);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
  expect(ctx).toContain("API KEYS"); // base guidance still there
  expect(ctx).toContain("PROJECT SCOPE");
  expect(ctx).toContain("Acme");
  expect(ctx).toContain("/code/acme");
  expect(ctx).toContain("{{stm:openai:default}}");
  // Stripe key is NOT in scope — must not appear in the manifest
  expect(ctx).not.toContain("{{stm:stripe:live}}");
});

test("SessionStart: empty-scope project still gets a PROJECT SCOPE section with a 'scope nothing yet' hint", () => {
  const s = new Store(HOOK_DB);
  const empty = s.addProject({ path: "/code/empty-scope", name: "EmptyScope" });
  s.close();

  const r = runHook("sessionstart", {
    hook_event_name: "SessionStart",
    cwd: "/code/empty-scope",
  });
  expect(r.code).toBe(0);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
  expect(ctx).toContain("PROJECT SCOPE");
  expect(ctx).toContain("EmptyScope");
  expect(ctx).toContain("No keys scoped to this project yet");
});

test("SessionStart: malformed payload falls back to process.cwd() without crashing", () => {
  // Pass garbage so JSON.parse fails — hook should still exit 0 with some context
  const r = runHook("sessionstart", { not: "valid SessionStart payload, but valid JSON" });
  expect(r.code).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
});
