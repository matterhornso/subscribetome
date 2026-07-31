// Credential broker tests.
//
// brokerRequest is pure + dependency-injected: we pass a fake `fetch` that
// records the outbound request and returns a canned Response, plus a fake
// `resolveKey`. So we can assert the load-bearing invariants without a keychain
// or a network:
//   - the real key is attached to the OUTBOUND request (and only there),
//   - the key is scrubbed out of what comes BACK to the caller,
//   - a crafted path can never send the key to another origin,
//   - client-supplied auth can't override the injected credential.

import { test, expect } from "bun:test";
import { brokerRequest, type BrokerTarget } from "../src/broker.ts";

const KEY = "sk-ant-secret-VALUE-do-not-leak-1234567890";

/** A fake fetch that records the last call and returns a canned response. */
function recordingFetch(resp: { status?: number; body?: string; headers?: Record<string, string> }) {
  const calls: { url: string; init: any }[] = [];
  const fn = (async (url: string, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(resp.body ?? "ok", {
      status: resp.status ?? 200,
      headers: resp.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const resolveKey = (_t: string, _l: string) => KEY;

test("bearer target: key is attached to the outbound Authorization header", async () => {
  const { fn, calls } = recordingFetch({ body: "hello" });
  const r = await brokerRequest(
    { tool: "openai", label: "default", path: "/v1/models", method: "GET", headers: {} },
    { resolveKey, fetch: fn },
  );
  expect(r.status).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://api.openai.com/v1/models");
  expect(calls[0].init.headers["Authorization"]).toBe(`Bearer ${KEY}`);
});

test("the key is NEVER present in the returned body (upstream echoes it back)", async () => {
  const { fn } = recordingFetch({ body: `error: invalid api key ${KEY} supplied` });
  const r = await brokerRequest(
    { tool: "openai", label: "default", path: "/v1/x", method: "GET", headers: {} },
    { resolveKey, fetch: fn },
  );
  expect(r.body).not.toContain(KEY);
  expect(r.body).toContain("[stm:redacted]");
});

test("the key is scrubbed from response headers too", async () => {
  const { fn } = recordingFetch({ headers: { "x-echo": KEY } });
  const r = await brokerRequest(
    { tool: "openai", label: "default", path: "/v1/x", method: "GET", headers: {} },
    { resolveKey, fetch: fn },
  );
  expect(r.headers["x-echo"]).not.toContain(KEY);
});

test("header-scheme target (anthropic x-api-key)", async () => {
  const { fn, calls } = recordingFetch({});
  await brokerRequest(
    { tool: "anthropic", label: "default", path: "/v1/messages", method: "POST", headers: {} },
    { resolveKey, fetch: fn },
  );
  expect(calls[0].init.headers["x-api-key"]).toBe(KEY);
  expect(calls[0].init.headers["Authorization"]).toBeUndefined();
});

test("query-scheme target puts the key in the query string, not a header", async () => {
  const targets: Record<string, BrokerTarget> = {
    demo: { id: "demo", baseUrl: "https://api.demo.test", auth: { kind: "query", name: "api_key" } },
  };
  const { fn, calls } = recordingFetch({});
  await brokerRequest(
    { tool: "demo", label: "default", path: "/v1/x", method: "GET", headers: {} },
    { resolveKey, fetch: fn, targets },
  );
  expect(calls[0].url).toBe(`https://api.demo.test/v1/x?api_key=${KEY}`);
});

test("client-supplied Authorization is dropped, not honored", async () => {
  const { fn, calls } = recordingFetch({});
  await brokerRequest(
    {
      tool: "openai",
      label: "default",
      path: "/v1/x",
      method: "GET",
      headers: { Authorization: "Bearer attacker-controlled", "X-Keep": "yes" },
    },
    { resolveKey, fetch: fn },
  );
  expect(calls[0].init.headers["Authorization"]).toBe(`Bearer ${KEY}`);
  expect(calls[0].init.headers["X-Keep"]).toBe("yes"); // non-auth headers pass through
});

test("SSRF: a protocol-relative path is refused before any fetch", async () => {
  const { fn, calls } = recordingFetch({});
  const r = await brokerRequest(
    { tool: "openai", label: "default", path: "//evil.example.com/steal", method: "GET", headers: {} },
    { resolveKey, fetch: fn },
  );
  expect(r.ok).toBe(false);
  expect(r.status).toBe(400);
  expect(calls).toHaveLength(0); // never called upstream, so key never left
});

test("SSRF: a backslash path is refused", async () => {
  const { fn, calls } = recordingFetch({});
  const r = await brokerRequest(
    { tool: "openai", label: "default", path: "/\\evil.example.com", method: "GET", headers: {} },
    { resolveKey, fetch: fn },
  );
  expect(r.ok).toBe(false);
  expect(calls).toHaveLength(0);
});

test("a path not starting with '/' is refused", async () => {
  const { fn } = recordingFetch({});
  const r = await brokerRequest(
    { tool: "openai", label: "default", path: "https://evil.example.com", method: "GET", headers: {} },
    { resolveKey, fetch: fn },
  );
  expect(r.ok).toBe(false);
  expect(r.status).toBe(400);
});

test("unknown tool returns 404 without resolving a key", async () => {
  const { fn } = recordingFetch({});
  let resolved = false;
  const r = await brokerRequest(
    { tool: "nope", label: "default", path: "/x", method: "GET", headers: {} },
    { resolveKey: () => { resolved = true; return KEY; }, fetch: fn },
  );
  expect(r.status).toBe(404);
  expect(resolved).toBe(false);
});

test("missing credential returns 401 and never calls upstream", async () => {
  const { fn, calls } = recordingFetch({});
  const r = await brokerRequest(
    { tool: "openai", label: "default", path: "/x", method: "GET", headers: {} },
    { resolveKey: () => null, fetch: fn },
  );
  expect(r.status).toBe(401);
  expect(calls).toHaveLength(0);
});

test("a network error message is scrubbed of the key (query-auth URL case)", async () => {
  const targets: Record<string, BrokerTarget> = {
    demo: { id: "demo", baseUrl: "https://api.demo.test", auth: { kind: "query", name: "api_key" } },
  };
  const failing = (async (url: string) => {
    throw new Error(`connect ECONNREFUSED for ${url}`); // url contains ?api_key=KEY
  }) as unknown as typeof fetch;
  const r = await brokerRequest(
    { tool: "demo", label: "default", path: "/x", method: "GET", headers: {} },
    { resolveKey, fetch: failing, targets },
  );
  expect(r.ok).toBe(false);
  expect(r.status).toBe(502);
  expect(r.error).not.toContain(KEY);
});
