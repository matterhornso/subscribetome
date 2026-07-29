// redactSyncError tests.
//
// A provider SDK or the underlying fetch/undici layer can fold the usage
// credential into an exception message or a failing request URL. syncOne runs
// every caught error through redactSyncError BEFORE it is written to the spend
// table or returned to the dashboard, so a secret never lands on disk in
// cleartext. These tests pin that scrubbing.

import { test, expect } from "bun:test";
import { redactSyncError } from "../src/sync.ts";

const CRED = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("exact credential is redacted wherever it appears", () => {
  const out = redactSyncError(`auth failed for key ${CRED} (HTTP 401)`, CRED);
  expect(out).not.toContain(CRED);
  expect(out).toContain("[redacted:credential]");
});

test("credential embedded in a request URL is redacted", () => {
  const out = redactSyncError(
    `fetch failed: GET https://api.example.com/v1/usage?key=${CRED}`,
    CRED,
  );
  expect(out).not.toContain(CRED);
  expect(out).toContain("[redacted:credential]");
});

test("credential of NON-key shape is still redacted by exact match", () => {
  // A plain-word credential detectKeys would never flag on shape alone —
  // the exact-substring layer still catches it.
  const plain = "hunter2-hunter2-hunter2";
  const out = redactSyncError(`bad token: ${plain}`, plain);
  expect(out).not.toContain(plain);
  expect(out).toContain("[redacted:credential]");
});

test("a DIFFERENT key-shaped token in the error is redacted by shape", () => {
  // The credential we passed isn't in the message, but the provider leaked a
  // different key-shaped string. The detectKeys layer scrubs it.
  const other = "sk-proj-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const out = redactSyncError(`unexpected token in response: ${other}`, CRED);
  expect(out).not.toContain(other);
  expect(out).toMatch(/\[redacted:/);
});

test("short credential (<8) is NOT used for exact redaction (avoids over-redaction)", () => {
  const out = redactSyncError("connection refused to host abc", "abc");
  expect(out).toBe("connection refused to host abc");
});

test("null credential falls back to shape-only redaction", () => {
  const out = redactSyncError(`leaked ${CRED} somehow`, null);
  expect(out).not.toContain(CRED);
  expect(out).toContain("[redacted:");
});

test("benign error with no secret passes through unchanged", () => {
  const msg = "network: getaddrinfo ENOTFOUND api.openai.com";
  expect(redactSyncError(msg, CRED)).toBe(msg);
});

test("credential containing regex metacharacters is redacted literally", () => {
  // split/join is a literal replace — a credential with regex-special chars
  // must not blow up or partially match.
  const weird = "key.with+special*chars(and)[brackets]$end";
  const out = redactSyncError(`error: ${weird} rejected`, weird);
  expect(out).not.toContain(weird);
  expect(out).toContain("[redacted:credential]");
});
