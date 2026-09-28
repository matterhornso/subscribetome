import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, CredentialRevisionError } from "../src/store.ts";
import { selectedSecretsRoute } from "../src/selected-secrets.ts";

function fakeKeystore() {
  const values = new Map<string, string>();
  const state: { onSet?: () => void; failSet: boolean; failDelete: boolean; reads: number } = { failSet: false, failDelete: false, reads: 0 };
  return { values, state, get: (ref: string) => { state.reads++; return values.get(ref) ?? null; },
    set: (ref: string, value: string) => { if (state.failSet) throw new Error("native-sensitive-error"); state.onSet?.(); values.set(ref, value); },
    delete: (ref: string) => { if (state.failDelete) throw new Error("native-sensitive-error"); values.delete(ref); },
  };
}
const create = { tool: "fixture", label: "default", value: "disposable-value-1", expectedRevision: null };

test("revisioned create and replace return metadata only; metadata does not resolve", () => {
  const ks = fakeKeystore(); const s = new Store(":memory:", ks);
  try {
    const first = s.putSelectedKey(create);
    expect(first.key.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(ks.state.reads).toBe(0);
    expect(JSON.stringify(s.listSelectedKeys())).not.toContain(create.value);
    expect(JSON.stringify(s.listSelectedKeys())).not.toContain([...ks.values.keys()][0]);
    const second = s.putSelectedKey({ ...create, value: "disposable-value-2", expectedRevision: first.key.revision });
    expect(second.key.revision).not.toBe(first.key.revision);
    expect(second.oldValueCleanupPending).toBe(false);
    expect(ks.values.size).toBe(1);
    expect(s.resolve("fixture", "default")).toBe("disposable-value-2");
    expect(JSON.stringify(s.db.query("SELECT * FROM keys").all())).not.toContain("disposable-value");
  } finally { s.close(); }
});

test("stale replacement, replayed create and revoked key never silently overwrite", () => {
  const ks = fakeKeystore(); const s = new Store(":memory:", ks);
  try {
    const first = s.putSelectedKey(create);
    const second = s.putSelectedKey({ ...create, value: "new-fixture", expectedRevision: first.key.revision });
    expect(() => s.putSelectedKey(create)).toThrow(CredentialRevisionError);
    expect(() => s.putSelectedKey({ ...create, expectedRevision: first.key.revision })).toThrow(CredentialRevisionError);
    expect(s.resolve("fixture", "default")).toBe("new-fixture");
    s.revokeKey("fixture", "default");
    expect(s.viewSelectedKey("fixture", "default")?.revision).not.toBe(second.key.revision);
    expect(() => s.putSelectedKey({ ...create, expectedRevision: second.key.revision })).toThrow(CredentialRevisionError);
    expect(s.resolve("fixture", "default")).toBeNull();
  } finally { s.close(); }
});

test("native rotation changes the integration revision without changing legacy response shape", () => {
  const ks = fakeKeystore(); const s = new Store(":memory:", ks);
  try {
    s.addKey(create); const before = s.viewSelectedKey("fixture", "default");
    s.rotateKey({ tool: "fixture", label: "default", newValue: "native-rotated-fixture" });
    expect(s.viewSelectedKey("fixture", "default")?.revision).not.toBe(before?.revision);
    expect(s.viewKey("fixture", "default")).not.toHaveProperty("revision");
  } finally { s.close(); }
});

test("keystore and database failures leave previous key intact; failed cleanup is reported", () => {
  const ks = fakeKeystore(); const s = new Store(":memory:", ks);
  try {
    const first = s.putSelectedKey(create);
    ks.state.failSet = true;
    expect(() => s.putSelectedKey({ ...create, expectedRevision: first.key.revision })).toThrow();
    ks.state.failSet = false;
    s.db.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON keys BEGIN SELECT RAISE(ABORT, 'fixture-write-failure'); END;");
    expect(() => s.putSelectedKey({ ...create, expectedRevision: first.key.revision })).toThrow();
    expect(ks.values.size).toBe(1);
    expect(s.resolve("fixture", "default")).toBe(create.value);
    s.db.exec("DROP TRIGGER fail_update;");
    ks.state.failDelete = true;
    const replaced = s.putSelectedKey({ ...create, value: "new-fixture", expectedRevision: first.key.revision });
    expect(replaced.oldValueCleanupPending).toBe(true);
    expect(s.resolve("fixture", "default")).toBe("new-fixture");
  } finally { s.close(); }
});

test("competing writer wins CAS and losing writer cleans only its own new value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stm-cas-"));
  const ks = fakeKeystore();
  const a = new Store(join(dir, "inventory.db"), ks); const b = new Store(join(dir, "inventory.db"), ks);
  try {
    const first = a.putSelectedKey(create);
    ks.state.onSet = () => {
      ks.state.onSet = undefined;
      b.putSelectedKey({ ...create, value: "winner-fixture", expectedRevision: first.key.revision });
    };
    expect(() => a.putSelectedKey({ ...create, value: "loser-fixture", expectedRevision: first.key.revision })).toThrow(CredentialRevisionError);
    expect(a.resolve("fixture", "default")).toBe("winner-fixture");
    expect([...ks.values.values()]).toEqual(["winner-fixture"]);
  } finally { a.close(); b.close(); await rm(dir, { recursive: true, force: true }); }
});

test("HTTP writes require revision precondition and never return values/native errors", async () => {
  const ks = fakeKeystore(); const s = new Store(":memory:", ks);
  const request = (body: unknown, token = "dashboard") => selectedSecretsRoute(new Request("http://127.0.0.1:4321/api/integrations/v1/keys", {
    method: "POST", headers: { host: "127.0.0.1:4321", "x-stm-token": token }, body: JSON.stringify(body),
  }), "dashboard", s, () => "in-memory fixture");
  try {
    expect((await request({ version: 1, ...create }, "broker")).status).toBe(401);
    expect(ks.values.size).toBe(0);
    expect((await request({ version: 1, tool: "fixture", label: "default", value: "value-with-no-precondition" })).status).toBe(400);
    const response = await request({ version: 1, ...create });
    expect(response.status).toBe(201);
    expect(await response.text()).not.toContain(create.value);
    expect((await request({ version: 1, ...create })).status).toBe(412);
    ks.state.failSet = true;
    const failed = await request({ version: 1, ...create, label: "other" });
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe('{"error":"credential_update_failed"}');
  } finally { s.close(); }
});

test("competing create cannot overwrite a newly inserted key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stm-create-race-"));
  const ks = fakeKeystore(); const path = join(dir, "inventory.db");
  const a = new Store(path, ks); const b = new Store(path, ks);
  try {
    ks.state.onSet = () => {
      ks.state.onSet = undefined;
      b.putSelectedKey({ ...create, value: "create-winner" });
    };
    expect(() => a.putSelectedKey({ ...create, value: "create-loser" })).toThrow(CredentialRevisionError);
    expect(a.resolve("fixture", "default")).toBe("create-winner");
    expect([...ks.values.values()]).toEqual(["create-winner"]);
  } finally { a.close(); b.close(); await rm(dir, { recursive: true, force: true }); }
});
