// Sealed-box crypto for team enrollment.
//
// The property under test: the team key can be sealed to a member's PUBLIC key
// by anyone, and opened ONLY by the holder of the matching private key. This is
// what removes the "share the passphrase out-of-band" step. Tested purely (no
// keychain) via generateIdentityKeys + seal + openWith.

import { test, expect } from "bun:test";
import { generateIdentityKeys, seal, openWith, memberIdFor, pubkeyMatchesMemberId } from "../src/teams/keypair.ts";

const TEAM_KEY = "team-key-9f3a2b1c-super-high-entropy-secret";

test("seal to a public key, open with the matching private key", () => {
  const alice = generateIdentityKeys();
  const env = seal(TEAM_KEY, alice.publicKeyB64);
  expect(openWith(env, alice.privateKeyB64)).toBe(TEAM_KEY);
});

test("a DIFFERENT private key cannot open the envelope", () => {
  const alice = generateIdentityKeys();
  const mallory = generateIdentityKeys();
  const env = seal(TEAM_KEY, alice.publicKeyB64);
  expect(() => openWith(env, mallory.privateKeyB64)).toThrow();
});

test("memberId is a 128-bit (32 hex) fingerprint of the public key", () => {
  const a = generateIdentityKeys();
  const again = generateIdentityKeys();
  expect(a.memberId).toHaveLength(32); // 128-bit — wide enough to be load-bearing
  expect(a.memberId).toMatch(/^[a-f0-9]{32}$/);
  expect(a.memberId).toBe(memberIdFor(a.publicKeyB64)); // deterministic
  expect(a.memberId).not.toBe(again.memberId);
});

test("pubkeyMatchesMemberId enforces the key<->id binding (blocks substitution)", () => {
  const alice = generateIdentityKeys();
  const mallory = generateIdentityKeys();
  // The genuine pair verifies.
  expect(pubkeyMatchesMemberId(alice.publicKeyB64, alice.memberId)).toBe(true);
  // Mallory's key does NOT hash to Alice's id — a substituted key is rejected.
  expect(pubkeyMatchesMemberId(mallory.publicKeyB64, alice.memberId)).toBe(false);
  expect(pubkeyMatchesMemberId("garbage", alice.memberId)).toBe(false);
});

test("sealing the same secret twice yields different envelopes (ephemeral key)", () => {
  const alice = generateIdentityKeys();
  const e1 = seal(TEAM_KEY, alice.publicKeyB64);
  const e2 = seal(TEAM_KEY, alice.publicKeyB64);
  expect(e1).not.toBe(e2);
  // ...but both open to the same secret.
  expect(openWith(e1, alice.privateKeyB64)).toBe(TEAM_KEY);
  expect(openWith(e2, alice.privateKeyB64)).toBe(TEAM_KEY);
});

test("a tampered envelope fails the auth tag", () => {
  const alice = generateIdentityKeys();
  const env = seal(TEAM_KEY, alice.publicKeyB64);
  const obj = JSON.parse(Buffer.from(env, "base64").toString("utf8"));
  const ct = Buffer.from(obj.ct, "base64");
  ct[0] ^= 0xff; // flip a byte of ciphertext
  obj.ct = ct.toString("base64");
  const tampered = Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
  expect(() => openWith(tampered, alice.privateKeyB64)).toThrow();
});

test("garbage input is rejected, not silently accepted", () => {
  const alice = generateIdentityKeys();
  expect(() => openWith("not-base64-json!!", alice.privateKeyB64)).toThrow();
});
