// STM Teams — per-member Ed25519 signing identity (attribution).
//
// A member's SEALING key (X25519, keypair.ts) lets them RECEIVE the team key at
// enrollment. This SIGNING key (Ed25519) lets them PROVE authorship of a report
// so the server can attribute usage to a verified member instead of a
// self-reported string. The two together define the member id, so neither key
// can be swapped.
//
// Zero-dependency (node:crypto). The private signing key lives only in the OS
// keychain; the public key is derived from it. Pure seam (generate/sign/verify)
// plus keychain-backed helpers, mirroring keypair.ts.
import {
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPublicKey,
  createPrivateKey,
  type KeyObject,
} from "node:crypto";
import { keychainGet, keychainSet, keychainDelete } from "../keychain.ts";

/** Reserved keychain ref for this member's Ed25519 signing private key. */
const SIGN_PRIV_REF = "__stm_team_sign_privkey__";

export interface SigningKeys {
  /** SPKI-DER public key, base64 — shareable. */
  publicKeyB64: string;
  /** PKCS8-DER private key, base64 — keychain only. */
  privateKeyB64: string;
}

function privFromB64(b64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
}
function pubFromB64(b64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
}
function pubToB64(pub: KeyObject): string {
  return Buffer.from(pub.export({ type: "spki", format: "der" })).toString("base64");
}

/** Generate a fresh Ed25519 signing keypair WITHOUT touching the keychain. */
export function generateSigningKeys(): SigningKeys {
  const kp = generateKeyPairSync("ed25519");
  return {
    publicKeyB64: pubToB64(kp.publicKey),
    privateKeyB64: Buffer.from(kp.privateKey.export({ type: "pkcs8", format: "der" })).toString("base64"),
  };
}

/** Sign `payload` with a private key (Ed25519 uses a null digest). */
export function sign(payload: string | Buffer, privateKeyB64: string): string {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  return edSign(null, data, privFromB64(privateKeyB64)).toString("base64");
}

/** Verify a signature; false (never throws) on any bad input. */
export function verify(payload: string | Buffer, sigB64: string, publicKeyB64: string): boolean {
  try {
    const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
    return edVerify(null, data, pubFromB64(publicKeyB64), Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
}

// ---- keychain-backed identity ------------------------------------------

export function hasSigningIdentity(): boolean {
  return keychainGet(SIGN_PRIV_REF) != null;
}

/** Ensure this machine has a signing key (generate + store on first call);
 *  return its public key. */
export function ensureSigningIdentity(): { publicKeyB64: string } {
  const existing = keychainGet(SIGN_PRIV_REF);
  if (!existing) {
    const gen = generateSigningKeys();
    keychainSet(SIGN_PRIV_REF, gen.privateKeyB64);
    return { publicKeyB64: gen.publicKeyB64 };
  }
  return { publicKeyB64: pubToB64(createPublicKey(privFromB64(existing))) };
}

/** Sign with this machine's stored signing key. */
export function signWithIdentity(payload: string | Buffer): string {
  const priv = keychainGet(SIGN_PRIV_REF);
  if (!priv) throw new Error("no signing identity on this machine — run `stm teams enroll-request` first");
  return sign(payload, priv);
}

export function clearSigningIdentity(): void {
  try { keychainDelete(SIGN_PRIV_REF); } catch { /* absent */ }
}
