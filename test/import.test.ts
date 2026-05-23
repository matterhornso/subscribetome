import { test, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanEnv, importSelected } from "../src/import.ts";
import { Store } from "../src/store.ts";

const dir = mkdtempSync(join(tmpdir(), "stm-imp-"));
writeFileSync(
  join(dir, ".env"),
  [
    "OPENAI_API_KEY=sk-abcdefghij1234567890klmnopqrst",
    "AWS_SECRET=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY",
    "DEBUG=true",
    "PORT=3000",
    "ALREADY=v={{stm:openai:default}}",
  ].join("\n"),
);

afterAll(() => {
  try {
    rmSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
});

test("scanEnv finds key-shaped vars and skips non-keys", () => {
  const names = scanEnv([dir]).map((c) => c.varName);
  expect(names).toContain("OPENAI_API_KEY");
  expect(names).toContain("AWS_SECRET");
  expect(names).not.toContain("DEBUG");
  expect(names).not.toContain("PORT");
});

test("scanEnv skips values that are already placeholders", () => {
  expect(scanEnv([dir]).map((c) => c.varName)).not.toContain("ALREADY");
});

test("scanEnv suggests a clean tool name and masks the value", () => {
  const openai = scanEnv([dir]).find((c) => c.varName === "OPENAI_API_KEY");
  expect(openai?.suggestedTool).toBe("openai");
  expect(openai?.valueMasked).not.toContain("abcdefghij1234567890");
});

// ---- Phase 3 of session-and-project-scope: scope auto-suggest ----------

const IMP_DB = join(tmpdir(), `stm-imp-test-${process.pid}.sqlite`);
const IMP_KC = `subscribetome-test-imp-${process.pid}`;
const IMP_DIR = mkdtempSync(join(tmpdir(), "stm-imp-p3-"));

// NOTE: deliberately avoid real-shaped key prefixes here. GitHub push
// protection scans for `sk-` (OpenAI) and `sk_test_` / `sk_live_`
// (Stripe) etc., and rejects pushes that look like real secrets even
// when they obviously aren't. We use plain x/a runs that still trigger
// the KEYISH_NAME hint via the variable name alone (which is enough
// for scanEnv to surface the candidate).
writeFileSync(
  join(IMP_DIR, ".env"),
  [
    "OPENAI_API_KEY=zzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    "STRIPE_SECRET_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ].join("\n"),
);

beforeAll(() => {
  process.env.STM_DB = IMP_DB;
  process.env.STM_KEYCHAIN_SERVICE = IMP_KC;
});

afterAll(() => {
  for (let i = 0; i < 100; i++) {
    try {
      execFileSync("/usr/bin/security", ["delete-generic-password", "-s", IMP_KC], {
        stdio: "ignore",
      });
    } catch {
      break;
    }
  }
  for (const s of ["", "-shm", "-wal"]) {
    try { rmSync(IMP_DB + s); } catch { /* ignore */ }
  }
  try { rmSync(IMP_DIR, { recursive: true }); } catch { /* ignore */ }
});

test("importSelected without cwd returns no scopeUpdate (back-compat)", () => {
  // Start clean so this case isn't polluted by other tests in the file.
  const s0 = new Store(IMP_DB);
  for (const p of s0.listProjects()) s0.removeProject(p.id);
  s0.db.exec(`DELETE FROM keys WHERE source = 'imported'`);
  s0.close();
  const sel = scanEnv([IMP_DIR]).map((c) => ({
    file: c.file,
    varName: c.varName,
    tool: c.suggestedTool,
    label: "default",
  }));
  const r = importSelected(sel, { dbPath: IMP_DB });
  expect(r.imported).toBeGreaterThan(0);
  expect(r.scopeUpdate).toBeUndefined();
});

test("importSelected with matching project silently adds to existing scope", () => {
  // Cleanup any pre-existing imported keys + projects so test is deterministic
  const s0 = new Store(IMP_DB);
  for (const p of s0.listProjects()) s0.removeProject(p.id);
  // delete already-imported keys so addKey can re-succeed
  s0.db.exec(`DELETE FROM keys WHERE source = 'imported'`);
  // create the project we'll match against
  s0.addProject({ path: IMP_DIR, name: "P3Test" });
  s0.close();

  const sel = scanEnv([IMP_DIR]).map((c) => ({
    file: c.file,
    varName: c.varName,
    tool: c.suggestedTool,
    label: "default",
  }));
  const r = importSelected(sel, { cwd: IMP_DIR, dbPath: IMP_DB });
  expect(r.imported).toBeGreaterThan(0);
  expect(r.scopeUpdate?.kind).toBe("added-to-existing");
  if (r.scopeUpdate?.kind === "added-to-existing") {
    expect(r.scopeUpdate.projectName).toBe("P3Test");
    expect(r.scopeUpdate.addedToScope.length).toBe(r.imported);
  }

  // Verify the scope rows actually landed
  const s = new Store(IMP_DB);
  const proj = s.getProjectByPath(IMP_DIR)!;
  const scope = s.projectScope(proj.id);
  s.close();
  expect(scope.length).toBe(r.imported);
});

test("importSelected with no matching project returns suggest-create", () => {
  // Drop projects so nothing matches
  const s0 = new Store(IMP_DB);
  for (const p of s0.listProjects()) s0.removeProject(p.id);
  s0.db.exec(`DELETE FROM keys WHERE source = 'imported'`);
  s0.close();

  const sel = scanEnv([IMP_DIR]).map((c) => ({
    file: c.file,
    varName: c.varName,
    tool: c.suggestedTool,
    label: "default",
  }));
  const r = importSelected(sel, { cwd: IMP_DIR, dbPath: IMP_DB });
  expect(r.imported).toBeGreaterThan(0);
  expect(r.scopeUpdate?.kind).toBe("suggest-create");
  if (r.scopeUpdate?.kind === "suggest-create") {
    expect(r.scopeUpdate.cwd).toBe(IMP_DIR);
    // Suggested name is the last path segment (e.g. "stm-imp-p3-XXXX")
    expect(r.scopeUpdate.suggestedName.length).toBeGreaterThan(0);
    expect(r.scopeUpdate.imported.length).toBe(r.imported);
    // Every imported (tool,label) is reported with grammar-normalized
    // tool names — the suggestion drives a downstream addProjectScope
    // that requires the canonical tool id.
    for (const { tool, label } of r.scopeUpdate.imported) {
      expect(tool).toMatch(/^[a-z0-9-]+$/);
      expect(label).toMatch(/^[a-z0-9-]+$/);
    }
  }
});

test("importSelected with matching project skips already-in-scope keys", () => {
  // Set up: project with one key already in scope, then re-import both.
  // Only the second key should appear in addedToScope.
  const s0 = new Store(IMP_DB);
  for (const p of s0.listProjects()) s0.removeProject(p.id);
  s0.db.exec(`DELETE FROM keys WHERE source = 'imported'`);
  const project = s0.addProject({ path: IMP_DIR, name: "Pre" });
  // Seed openai:default into the inventory + scope BEFORE the import
  s0.addKey({ tool: "openai", label: "default", value: "pre-existing-value" });
  s0.addProjectScope(project.id, "openai", "default");
  s0.close();

  // Now import — openai already exists so addKey will throw; stripe is new.
  const sel = scanEnv([IMP_DIR]).map((c) => ({
    file: c.file,
    varName: c.varName,
    tool: c.suggestedTool,
    label: "default",
  }));
  const r = importSelected(sel, { cwd: IMP_DIR, dbPath: IMP_DB });
  // openai failed (already exists), stripe imported
  expect(r.imported).toBe(1);
  expect(r.scopeUpdate?.kind).toBe("added-to-existing");
  if (r.scopeUpdate?.kind === "added-to-existing") {
    // Only stripe was newly added to scope. openai was already there
    // AND already in scope, so it isn't in this list.
    expect(r.scopeUpdate.addedToScope.length).toBe(1);
    expect(r.scopeUpdate.addedToScope[0].tool).toBe("stripe");
  }
});
