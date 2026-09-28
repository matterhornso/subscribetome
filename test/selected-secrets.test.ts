import { expect, test } from "bun:test";
import { selectedSecretsRoute, type SelectedSecretStore } from "../src/selected-secrets.ts";

function fixture() {
  const reads: string[] = [];
  const store: SelectedSecretStore = {
    listKeys: () => [{ tool: "example", label: "default", status: "active", created_at: "2026-09-28" }],
    viewKey: (tool) => tool === "example" ? { status: "active" } : null,
    resolve: (tool, label) => { reads.push(`${tool}:${label}`); return "disposable-fixture-value"; },
  };
  const invoke = (body: unknown, token = "test-dashboard", headers = {}) => selectedSecretsRoute(new Request("http://127.0.0.1:4321/api/integrations/v1/resolve", {
    method: "POST", headers: { host: "127.0.0.1:4321", "x-stm-token": token, ...headers }, body: JSON.stringify(body),
  }), "test-dashboard", store, () => "in-memory test backend");
  return { reads, store, invoke };
}

test("explicit selection resolves only selected credentials and preserves exact alias", async () => {
  const f = fixture();
  const r = await f.invoke({ version: 1, bindings: [{ envName: "TOOL_API_KEY", tool: "example", label: "default" }] });
  expect(await r.json()).toEqual({ version: 1, values: { TOOL_API_KEY: "disposable-fixture-value" } });
  expect(f.reads).toEqual(["example:default"]);
  expect(r.headers.get("cache-control")).toBe("no-store");
});

test("empty selection never means all keys", async () => {
  const f = fixture();
  expect(await (await f.invoke({ version: 1, bindings: [] })).json()).toEqual({ version: 1, values: {} });
  expect(f.reads).toEqual([]);
});

for (const name of ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "MATTERHORN_WORK_TOKEN", "STM_TOKEN", "__proto__", "9KEY", "HTTPS_PROXY"]) {
  test(`rejects unsafe name ${name} without resolution`, async () => {
    const f = fixture();
    expect((await f.invoke({ version: 1, bindings: [{ envName: name, tool: "example", label: "default" }] })).status).toBe(400);
    expect(f.reads).toEqual([]);
  });
}

test("unknown, duplicate, excessive and noncanonical selections resolve nothing", async () => {
  const entry = { envName: "API_KEY", tool: "example", label: "default" };
  for (const bindings of [[entry, entry], [entry, { ...entry, envName: "OTHER_KEY", tool: "unknown" }], Array(33).fill(entry), [{ ...entry, tool: "Example" }]]) {
    const f = fixture();
    expect((await f.invoke({ version: 1, bindings })).ok).toBe(false);
    expect(f.reads).toEqual([]);
  }
});

test("wrong/missing/broker token and browser origins cannot resolve", async () => {
  const f = fixture();
  for (const token of ["", "wrong", "broker-token"]) expect((await f.invoke({ version: 1, bindings: [] }, token)).status).toBe(401);
  expect((await f.invoke({ version: 1, bindings: [] }, "test-dashboard", { origin: "http://127.0.0.1:4321" })).status).toBe(403);
  expect((await f.invoke({ version: 1, bindings: [] }, "test-dashboard", { host: "evil.example" })).status).toBe(403);
  expect(f.reads).toEqual([]);
});

test("errors never echo keystore errors or secret values", async () => {
  const f = fixture();
  f.store.resolve = () => { throw new Error("sensitive-keystore-value"); };
  const r = await f.invoke({ version: 1, bindings: [{ envName: "API_KEY", tool: "example", label: "default" }] });
  expect(r.status).toBe(503);
  expect(await r.text()).toBe('{"error":"keystore_unavailable"}');
});

test("bounded body and bounded values fail without partial output", async () => {
  const f = fixture();
  expect((await f.invoke({ padding: "x".repeat(40_000) })).status).toBe(400);
  expect(f.reads).toEqual([]);
  f.store.resolve = () => "x".repeat(16_385);
  expect((await f.invoke({ version: 1, bindings: [{ envName: "API_KEY", tool: "example", label: "default" }] })).status).toBe(409);
});

test("metadata and capabilities do not resolve secrets", async () => {
  const f = fixture();
  for (const path of ["keys", "capabilities"]) {
    const r = await selectedSecretsRoute(new Request(`http://127.0.0.1:4321/api/integrations/v1/${path}`, { headers: { host: "127.0.0.1:4321", "x-stm-token": "test-dashboard" } }), "test-dashboard", f.store, () => "test backend");
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain("disposable-fixture-value");
  }
  expect(f.reads).toEqual([]);
});

test("mixed-case aliases are preserved; case-fold collisions are rejected", async () => {
  const f = fixture();
  const entry = { envName: "example_Key", tool: "example", label: "default" };
  expect(await (await f.invoke({ version: 1, bindings: [entry] })).json()).toEqual({ version: 1, values: { example_Key: "disposable-fixture-value" } });
  const before = f.reads.length;
  expect((await f.invoke({ version: 1, bindings: [entry, { ...entry, envName: "EXAMPLE_KEY" }] })).status).toBe(400);
  expect(f.reads.length).toBe(before);
});

test("query token is never accepted by the integration API", async () => {
  const f = fixture();
  const r = await selectedSecretsRoute(new Request("http://127.0.0.1:4321/api/integrations/v1/keys?token=test-dashboard", { headers: { host: "127.0.0.1:4321" } }), "test-dashboard", f.store, () => "fixture");
  expect(r.status).toBe(401);
  expect(f.reads).toEqual([]);
});
