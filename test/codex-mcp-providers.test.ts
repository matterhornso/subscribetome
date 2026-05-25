// Tests for the Codex MCP-wrapped provider registry (v0.7.0).
//
// Keep these focused on the registry shape + auth-header builder —
// the network layer is exercised in test/codex-mcp.test.ts.

import { test, expect } from "bun:test";
import {
  MCP_PROVIDERS,
  findProvider,
  listProviderIds,
  buildAuthHeader,
  toolSchema,
} from "../src/agents/codex-mcp-providers.ts";

test("MCP_PROVIDERS ships the v0.7.0 launch set (openai, anthropic, stripe, github, resend)", () => {
  const ids = MCP_PROVIDERS.map((p) => p.id).sort();
  expect(ids).toEqual(["anthropic", "github", "openai", "resend", "stripe"]);
});

test("every provider has an https baseURL and a credential pointer", () => {
  for (const p of MCP_PROVIDERS) {
    expect(p.baseURL.startsWith("https://")).toBe(true);
    expect(p.credential.tool).toBeTruthy();
    expect(p.credential.label).toBeTruthy();
  }
});

test("findProvider returns null for an unknown id", () => {
  expect(findProvider("not-a-real-provider")).toBeNull();
});

test("findProvider returns the def for a known id", () => {
  const oa = findProvider("openai");
  expect(oa?.name).toBe("OpenAI");
  expect(oa?.baseURL).toBe("https://api.openai.com");
});

test("listProviderIds returns all registry ids", () => {
  expect(listProviderIds().length).toBe(MCP_PROVIDERS.length);
});

// ---- buildAuthHeader ----------------------------------------------------

test("buildAuthHeader: bearer scheme produces Authorization: Bearer <value>", () => {
  const def = findProvider("openai")!;
  const h = buildAuthHeader(def, "sk-test-1234");
  expect(h.name).toBe("Authorization");
  expect(h.value).toBe("Bearer sk-test-1234");
});

test("buildAuthHeader: x-api-key scheme produces a raw x-api-key header", () => {
  const def = findProvider("anthropic")!;
  const h = buildAuthHeader(def, "sk-ant-xyz");
  expect(h.name).toBe("x-api-key");
  expect(h.value).toBe("sk-ant-xyz");
});

test("buildAuthHeader: basic-user scheme uses Stripe-style 'key as username, empty pass'", () => {
  const def = findProvider("stripe")!;
  const h = buildAuthHeader(def, "sk_test_stripe");
  expect(h.name).toBe("Authorization");
  // base64("sk_test_stripe:")
  const expected = "Basic " + Buffer.from("sk_test_stripe:").toString("base64");
  expect(h.value).toBe(expected);
});

// ---- toolSchema ---------------------------------------------------------

test("toolSchema names the v0.7.0 entry point + enumerates known providers", () => {
  const s = toolSchema();
  expect(s.name).toBe("stm_http_request");
  // Provider enum in the schema matches the registry
  const enumIds = (s.inputSchema as any).properties.provider.enum as string[];
  expect(enumIds.sort()).toEqual([
    "anthropic", "github", "openai", "resend", "stripe",
  ]);
  // path is required (load-bearing — agent must specify the endpoint)
  expect((s.inputSchema as any).required).toContain("provider");
  expect((s.inputSchema as any).required).toContain("path");
});

test("toolSchema explicitly tells the agent NOT to provide auth headers", () => {
  const s = toolSchema();
  // The description on the `headers` property carries the "do not
  // pass Authorization" rule — defense-in-depth for an agent that
  // tries to guess.
  const headersDesc = (s.inputSchema as any).properties.headers.description as string;
  expect(headersDesc.toLowerCase()).toContain("authorization");
  expect(headersDesc.toLowerCase()).toContain("must not");
});
