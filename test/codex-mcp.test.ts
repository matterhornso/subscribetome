// Codex MCP server tests (v0.7.0 — Option 2, higher assurance).
//
// We test the JSON-RPC handler directly with injected fetch +
// resolveCredential. The stdio framing is integration-tested via a
// quick smoke (one initialize roundtrip) but the per-method matrix
// lives here, against `handleRequest`.
//
// THE LOAD-BEARING CLAIM of v0.7.0 is "the agent never sees or
// handles the API key". The tests assert that contract three ways:
//   (a) the credential value never appears in the JSON-RPC RESPONSE
//       returned to the client (i.e. to Codex's agent),
//   (b) the credential value IS placed in the upstream HTTP
//       request's Authorization (or equivalent) header,
//   (c) an agent that tries to override Authorization on its own
//       has its override stripped before the server-injected
//       header is added.

import { test, expect } from "bun:test";
import { handleRequest, type ServerDeps } from "../src/agents/codex-mcp.ts";

function makeDeps(opts?: {
  credentials?: Record<string, string>;     // "tool/label" → value
  fetchImpl?: typeof fetch;
}): { deps: ServerDeps; fetchCalls: Array<{ url: string; init: RequestInit }> } {
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch =
    opts?.fetchImpl ??
    (async (url: any, init: any) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, echo: init?.body ?? null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  return {
    fetchCalls,
    deps: {
      resolveCredential(tool, label) {
        return opts?.credentials?.[`${tool}/${label}`] ?? null;
      },
      fetch: fetchImpl,
    },
  };
}

// ---- initialize ---------------------------------------------------------

test("initialize handshake returns serverInfo + tools capability", async () => {
  const { deps } = makeDeps();
  const r = await handleRequest(
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    deps,
  );
  expect(r?.result).toBeDefined();
  const result = r!.result as any;
  expect(result.serverInfo.name).toBe("subscribetome");
  expect(result.capabilities.tools).toBeDefined();
});

test("notifications/initialized is a notification and returns no response", async () => {
  const { deps } = makeDeps();
  const r = await handleRequest(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    deps,
  );
  expect(r).toBeNull();
});

test("ping returns an empty object result", async () => {
  const { deps } = makeDeps();
  const r = await handleRequest(
    { jsonrpc: "2.0", id: 2, method: "ping" },
    deps,
  );
  expect(r?.result).toEqual({});
});

// ---- tools/list ---------------------------------------------------------

test("tools/list returns the stm_http_request tool with its full schema", async () => {
  const { deps } = makeDeps();
  const r = await handleRequest(
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    deps,
  );
  const tools = (r!.result as any).tools;
  expect(tools.length).toBe(1);
  expect(tools[0].name).toBe("stm_http_request");
});

// ---- tools/call: HEADLINE TESTS -----------------------------------------

test("HEADLINE: the credential value is placed in the upstream Authorization header — NEVER in the response to the agent", async () => {
  const SECRET = "sk-this-must-stay-inside-the-server-XXXXX";
  const { deps, fetchCalls } = makeDeps({
    credentials: { "openai/default": SECRET },
  });
  const r = await handleRequest(
    {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "stm_http_request",
        arguments: {
          provider: "openai",
          method: "POST",
          path: "/v1/chat/completions",
          body: { model: "gpt-4o-mini", messages: [] },
        },
      },
    },
    deps,
  );
  // (b) The credential is in the upstream Authorization header.
  const upstream = fetchCalls[0];
  const upstreamAuth = (upstream.init.headers as any)["Authorization"];
  expect(upstreamAuth).toBe(`Bearer ${SECRET}`);

  // (a) The credential is NOT in the JSON-RPC response sent back
  // to the client (the agent).
  const responseJson = JSON.stringify(r);
  expect(responseJson).not.toContain(SECRET);
});

test("HEADLINE: an agent that tries to override Authorization gets the header stripped before the server injects its own", async () => {
  const SECRET = "sk-good-from-stm";
  const { deps, fetchCalls } = makeDeps({
    credentials: { "openai/default": SECRET },
  });
  await handleRequest(
    {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "stm_http_request",
        arguments: {
          provider: "openai",
          method: "POST",
          path: "/v1/chat/completions",
          headers: {
            Authorization: "Bearer sk-MALICIOUS-INJECTION-by-agent",
          },
          body: {},
        },
      },
    },
    deps,
  );
  const upstreamAuth = (fetchCalls[0].init.headers as any)["Authorization"];
  // The agent's value is gone; only the server-injected value
  // reaches the upstream.
  expect(upstreamAuth).not.toContain("MALICIOUS-INJECTION");
  expect(upstreamAuth).toBe(`Bearer ${SECRET}`);
});

// ---- tools/call: routing + URL building ---------------------------------

test("tools/call routes to the registered provider's baseURL + path", async () => {
  const { deps, fetchCalls } = makeDeps({
    credentials: { "anthropic/default": "sk-ant" },
  });
  await handleRequest(
    {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "stm_http_request",
        arguments: { provider: "anthropic", path: "/v1/messages" },
      },
    },
    deps,
  );
  expect(fetchCalls[0].url).toBe("https://api.anthropic.com/v1/messages");
});

test("tools/call appends query params via URL.searchParams", async () => {
  const { deps, fetchCalls } = makeDeps({ credentials: { "github/default": "g" } });
  await handleRequest(
    {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "stm_http_request",
        arguments: {
          provider: "github",
          path: "/search/repositories",
          query: { q: "topic:bun", per_page: "5" },
        },
      },
    },
    deps,
  );
  const u = new URL(fetchCalls[0].url);
  expect(u.searchParams.get("q")).toBe("topic:bun");
  expect(u.searchParams.get("per_page")).toBe("5");
});

test("tools/call attaches provider default headers (anthropic-version, Accept, etc.)", async () => {
  const { deps, fetchCalls } = makeDeps({
    credentials: { "anthropic/default": "x" },
  });
  await handleRequest(
    {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "stm_http_request",
        arguments: { provider: "anthropic", path: "/v1/messages" },
      },
    },
    deps,
  );
  const headers = fetchCalls[0].init.headers as Record<string, string>;
  expect(headers["anthropic-version"]).toBe("2023-06-01");
  expect(headers["Content-Type"]).toBe("application/json");
});

test("tools/call uses x-api-key auth for Anthropic", async () => {
  const { deps, fetchCalls } = makeDeps({
    credentials: { "anthropic/default": "sk-ant-xyz" },
  });
  await handleRequest(
    {
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: {
        name: "stm_http_request",
        arguments: { provider: "anthropic", path: "/v1/messages" },
      },
    },
    deps,
  );
  const headers = fetchCalls[0].init.headers as Record<string, string>;
  expect(headers["x-api-key"]).toBe("sk-ant-xyz");
});

test("tools/call uses Basic auth for Stripe (Stripe convention)", async () => {
  const { deps, fetchCalls } = makeDeps({
    credentials: { "stripe/default": "sk_test_stripe" },
  });
  await handleRequest(
    {
      jsonrpc: "2.0",
      id: 24,
      method: "tools/call",
      params: {
        name: "stm_http_request",
        arguments: { provider: "stripe", path: "/v1/customers" },
      },
    },
    deps,
  );
  const headers = fetchCalls[0].init.headers as Record<string, string>;
  const expected = "Basic " + Buffer.from("sk_test_stripe:").toString("base64");
  expect(headers["Authorization"]).toBe(expected);
});

test("tools/call JSON.stringify-s a JSON body for application/json providers", async () => {
  const { deps, fetchCalls } = makeDeps({ credentials: { "openai/default": "x" } });
  await handleRequest(
    {
      jsonrpc: "2.0",
      id: 25,
      method: "tools/call",
      params: {
        name: "stm_http_request",
        arguments: {
          provider: "openai",
          method: "POST",
          path: "/v1/chat/completions",
          body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
        },
      },
    },
    deps,
  );
  const body = fetchCalls[0].init.body as string;
  expect(typeof body).toBe("string");
  expect(JSON.parse(body)).toEqual({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
  });
});

test("tools/call passes a string body verbatim (form-encoded providers)", async () => {
  const { deps, fetchCalls } = makeDeps({
    credentials: { "stripe/default": "k" },
  });
  await handleRequest(
    {
      jsonrpc: "2.0",
      id: 26,
      method: "tools/call",
      params: {
        name: "stm_http_request",
        arguments: {
          provider: "stripe",
          method: "POST",
          path: "/v1/customers",
          body: "name=Alice&email=alice%40example.com",
        },
      },
    },
    deps,
  );
  expect(fetchCalls[0].init.body).toBe("name=Alice&email=alice%40example.com");
});

// ---- tools/call: error paths --------------------------------------------

test("tools/call returns isError when the provider is unknown", async () => {
  const { deps } = makeDeps();
  const r = await handleRequest(
    {
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: {
        name: "stm_http_request",
        arguments: { provider: "not-real", path: "/x" },
      },
    },
    deps,
  );
  const result = r!.result as any;
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("unknown provider");
});

test("tools/call returns isError when no credential is available for the provider", async () => {
  const { deps } = makeDeps({ credentials: {} });
  const r = await handleRequest(
    {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: {
        name: "stm_http_request",
        arguments: { provider: "openai", path: "/v1/chat/completions" },
      },
    },
    deps,
  );
  const result = r!.result as any;
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("no stm credential");
});

test("tools/call returns isError when path doesn't start with '/'", async () => {
  const { deps } = makeDeps({ credentials: { "openai/default": "x" } });
  const r = await handleRequest(
    {
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: {
        name: "stm_http_request",
        arguments: { provider: "openai", path: "v1/chat/completions" },
      },
    },
    deps,
  );
  const result = r!.result as any;
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("must start with '/'");
});

test("tools/call returns isError=true when the upstream returns 4xx/5xx", async () => {
  const fetchImpl = (async () =>
    new Response("rate limited", {
      status: 429,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;
  const { deps } = makeDeps({
    credentials: { "openai/default": "x" },
    fetchImpl,
  });
  const r = await handleRequest(
    {
      jsonrpc: "2.0",
      id: 33,
      method: "tools/call",
      params: {
        name: "stm_http_request",
        arguments: { provider: "openai", path: "/v1/chat/completions" },
      },
    },
    deps,
  );
  const result = r!.result as any;
  expect(result.isError).toBe(true);
  const payload = JSON.parse(result.content[0].text);
  expect(payload.status).toBe(429);
});

// ---- tools/call response shape ------------------------------------------

test("tools/call response is the MCP content[] shape with status + headers + body in JSON text", async () => {
  const { deps } = makeDeps({ credentials: { "openai/default": "x" } });
  const r = await handleRequest(
    {
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "stm_http_request",
        arguments: { provider: "openai", path: "/v1/models" },
      },
    },
    deps,
  );
  const result = r!.result as any;
  expect(Array.isArray(result.content)).toBe(true);
  expect(result.content[0].type).toBe("text");
  const payload = JSON.parse(result.content[0].text);
  expect(payload.status).toBe(200);
  expect(payload.headers).toBeDefined();
  expect(payload.body).toBeDefined();
});

test("tools/call clips an oversize upstream response", async () => {
  const huge = "x".repeat(300 * 1024); // 300 KB, exceeds 256 KB cap
  const fetchImpl = (async () =>
    new Response(huge, { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;
  const { deps } = makeDeps({
    credentials: { "openai/default": "x" },
    fetchImpl,
  });
  const r = await handleRequest(
    {
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "stm_http_request",
        arguments: { provider: "openai", path: "/v1/x" },
      },
    },
    deps,
  );
  const result = r!.result as any;
  const payload = JSON.parse(result.content[0].text);
  expect(payload.body).toContain("(truncated;");
  expect(payload.body.length).toBeLessThan(huge.length);
});

// ---- JSON-RPC framing edge cases ----------------------------------------

test("unknown method returns -32601 method not found", async () => {
  const { deps } = makeDeps();
  const r = await handleRequest(
    { jsonrpc: "2.0", id: 50, method: "totally/made/up" },
    deps,
  );
  expect(r?.error?.code).toBe(-32601);
});

test("malformed envelope (missing jsonrpc) returns -32600", async () => {
  const { deps } = makeDeps();
  const r = await handleRequest(
    { id: 60, method: "tools/list" } as any,
    deps,
  );
  expect(r?.error?.code).toBe(-32600);
});

test("a request without id is a notification and never returns a reply", async () => {
  const { deps } = makeDeps();
  const r = await handleRequest(
    { jsonrpc: "2.0", method: "tools/list" },
    deps,
  );
  expect(r).toBeNull();
});
