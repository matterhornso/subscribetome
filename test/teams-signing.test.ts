// Ed25519 signing primitive for member attribution.
//
// The property: a member can PROVE authorship of a report, and no one else can
// forge it. Tested purely (no keychain) via generateSigningKeys + sign + verify.

import { test, expect } from "bun:test";
import { generateSigningKeys, sign, verify } from "../src/teams/signing.ts";

const MSG = "POST\n/v1/audit\n2026-07-31T00:00:00Z\nabc123\ndeadbeef";

test("sign then verify with the matching public key", () => {
  const k = generateSigningKeys();
  const s = sign(MSG, k.privateKeyB64);
  expect(verify(MSG, s, k.publicKeyB64)).toBe(true);
});

test("a signature does NOT verify against a different public key", () => {
  const alice = generateSigningKeys();
  const mallory = generateSigningKeys();
  const s = sign(MSG, alice.privateKeyB64);
  expect(verify(MSG, s, mallory.publicKeyB64)).toBe(false);
});

test("a tampered payload fails verification", () => {
  const k = generateSigningKeys();
  const s = sign(MSG, k.privateKeyB64);
  expect(verify(MSG + "x", s, k.publicKeyB64)).toBe(false);
});

test("garbage signature / key is rejected, never throws", () => {
  const k = generateSigningKeys();
  expect(verify(MSG, "not-a-sig", k.publicKeyB64)).toBe(false);
  expect(verify(MSG, sign(MSG, k.privateKeyB64), "not-a-key")).toBe(false);
});

test("signatures are deterministic per (key, message) — Ed25519", () => {
  const k = generateSigningKeys();
  expect(sign(MSG, k.privateKeyB64)).toBe(sign(MSG, k.privateKeyB64));
});
