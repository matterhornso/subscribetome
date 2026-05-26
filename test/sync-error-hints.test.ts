// humanizeSyncError tests — v0.8.0.
//
// Maps raw sync error strings (provider exceptions, fetch failures,
// timeouts) to actionable hints. Each test pins one error class.
// If a new shape needs to land, add a row here, add a branch in
// src/sync.ts, ship.

import { test, expect } from "bun:test";
import { humanizeSyncError } from "../src/sync.ts";

test("auth failure (401) is recognised", () => {
  const h = humanizeSyncError("auth failed (HTTP 401) — is this an admin key?");
  expect(h.summary).toBe("authentication failed");
  expect(h.hint).toMatch(/rotate.*provider's dashboard/i);
});

test("auth failure (403) is recognised", () => {
  const h = humanizeSyncError("auth failed (HTTP 403)");
  expect(h.summary).toBe("authentication failed");
  expect(h.hint).not.toBeNull();
});

test("rate limit is recognised", () => {
  const h = humanizeSyncError("rate limited (HTTP 429) — try again later");
  expect(h.summary).toBe("rate limited");
  expect(h.hint).toMatch(/wait a minute/i);
});

test("provider 5xx is recognised", () => {
  const h = humanizeSyncError("HTTP 503");
  expect(h.summary).toBe("provider API error");
  expect(h.hint).toMatch(/status page/i);
});

test("DNS lookup failure is recognised (ENOTFOUND)", () => {
  const h = humanizeSyncError("network: getaddrinfo ENOTFOUND api.openai.com");
  expect(h.summary).toBe("DNS lookup failed");
  expect(h.hint).toMatch(/VPN.*firewall|online/i);
});

test("connection refused is recognised", () => {
  const h = humanizeSyncError("network: connect ECONNREFUSED 8.8.8.8:443");
  expect(h.summary).toBe("connection refused");
  expect(h.hint).toMatch(/VPN.*firewall|proxy/i);
});

test("timeout is recognised", () => {
  const h = humanizeSyncError("network: ETIMEDOUT");
  expect(h.summary).toBe("request timed out");
  expect(h.hint).toMatch(/retry|15s/i);
});

test("AbortError (our 15s ceiling firing) is recognised", () => {
  const h = humanizeSyncError("AbortError: The operation was aborted");
  expect(h.summary).toBe("request timed out");
});

test("TLS error is recognised", () => {
  const h = humanizeSyncError("network: certificate has expired");
  expect(h.summary).toBe("TLS / certificate error");
  expect(h.hint).toMatch(/trust store|proxy/i);
});

test("generic network error has a useful hint", () => {
  const h = humanizeSyncError("network: fetch failed");
  expect(h.summary).toMatch(/network/i);
  expect(h.hint).toMatch(/retry/i);
});

test("non-JSON / unexpected shape error points at stm not the user", () => {
  const h = humanizeSyncError("provider returned non-JSON response");
  expect(h.summary).toBe("unexpected provider response");
  expect(h.hint).toMatch(/GitHub|API/i);
});

test("non-numeric spend error is recognised", () => {
  const h = humanizeSyncError("provider returned non-numeric spend");
  expect(h.summary).toBe("unexpected provider response");
});

test("unknown error falls through with no hint", () => {
  const h = humanizeSyncError("totally novel failure mode");
  expect(h.summary).toBe("totally novel failure mode");
  expect(h.hint).toBeNull();
});

test("raw field always preserves the original message", () => {
  const cases = [
    "auth failed (HTTP 401)",
    "ECONNREFUSED",
    "totally novel failure mode",
  ];
  for (const c of cases) {
    expect(humanizeSyncError(c).raw).toBe(c);
  }
});
