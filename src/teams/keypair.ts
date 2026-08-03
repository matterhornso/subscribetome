// STM Teams — member identity + a zero-dependency sealed box.
//
// This is what lets a new member join a team WITHOUT anyone passing the shared
// team key around out-of-band. Each member has an X25519 identity keypair. The
// team key (a high-entropy secret that encrypts the vault) is "sealed" to a
// member's PUBLIC key by anyone who holds it; only that member's PRIVATE key can
// open it. Enrollment becomes: an existing member seals the team key to the
// newcomer's public key and uploads the envelope; the newcomer opens it locally.
//
// Crypto: ephemeral-static X25519 ECDH -> HKDF-SHA256 -> AES-256-GCM. All from
// node:crypto (Bun-native), no third-party dependency — STM ships zero runtime
// deps. The private key lives only in the OS keychain; the public key and the
// member id are DERIVED from it, so nothing else is stored.
import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  diffieHellman,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  type KeyObject,
} from "node:crypto";
import { keychainGet, keychainSet, keychainDelete } from "../keychain.ts";

/** Reserved keychain ref for this member's X25519 private key (PKCS8 DER, b64). */
const MEMBER_PRIV_REF = "__stm_team_member_privkey__";
const SEAL_INFO = Buffer.from("stm-team-seal-v1");

export interface Identity {
  /** Stable id derived from the public key — how the server addresses a member. */
  memberId: string;
  /** SPKI-DER public key, base64 — shareable, safe to publish. */
  publicKeyB64: string;
}

interface Envelope {
  v: 1;
  /** Ephemeral X25519 public key (SPKI DER, b64). */
  epk: string;
  iv: string;
  tag: string;
  ct: string;
}

function pubToB64(pub: KeyObject): string {
  return Buffer.from(pub.export({ type: "spki", format: "der" })).toString("base64");
}
function pubFromB64(b64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
}
/**
 * The member id is a fingerprint of the public key — and it is SECURITY-CRITICAL:
 * enrollment verifies that a server-supplied pubkey hashes to the id an operator
 * typed, which is what stops a malicious server from substituting its own key.
 * So the fingerprint must be wide enough to resist a second-preimage grind:
 * 32 hex chars = 128 bits (was 64 — too short for a value that gates the vault).
 */
export function memberIdFor(pubB64: string): string {
  return createHash("sha256").update(Buffer.from(pubB64, "base64")).digest("hex").slice(0, 32);
}

/** True iff `pubB64` is the exact public key that `memberId` fingerprints. The
 *  load-bearing check for enrollment: never seal the team key to a key that
 *  doesn't hash to the id you were given out-of-band. */
export function pubkeyMatchesMemberId(pubB64: string, memberId: string): boolean {
  try {
    return memberIdFor(pubB64) === memberId;
  } catch {
    return false;
  }
}

function privFromB64(b64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
}

function loadPrivate(): KeyObject | null {
  const b64 = keychainGet(MEMBER_PRIV_REF);
  if (!b64) return null;
  return privFromB64(b64);
}

/**
 * Generate a fresh identity keypair WITHOUT touching the keychain. Pure — used
 * by `ensureIdentity` (which then stores the private key) and directly by tests.
 */
export function generateIdentityKeys(): { publicKeyB64: string; privateKeyB64: string; memberId: string } {
  const kp = generateKeyPairSync("x25519");
  const publicKeyB64 = pubToB64(kp.publicKey);
  return {
    publicKeyB64,
    privateKeyB64: Buffer.from(kp.privateKey.export({ type: "pkcs8", format: "der" })).toString("base64"),
    memberId: memberIdFor(publicKeyB64),
  };
}

/** True once this machine has generated its member identity. */
export function hasIdentity(): boolean {
  return keychainGet(MEMBER_PRIV_REF) != null;
}

/**
 * Return this machine's identity, generating the keypair on first call. The
 * private key is stored (once) in the keychain; the public key + member id are
 * derived from it every time, so there's no other persistent state.
 */
export function ensureIdentity(): Identity {
  let priv = loadPrivate();
  if (!priv) {
    const gen = generateIdentityKeys();
    keychainSet(MEMBER_PRIV_REF, gen.privateKeyB64);
    return { memberId: gen.memberId, publicKeyB64: gen.publicKeyB64 };
  }
  const pubB64 = pubToB64(createPublicKey(priv));
  return { memberId: memberIdFor(pubB64), publicKeyB64: pubB64 };
}

export function clearIdentity(): void {
  try { keychainDelete(MEMBER_PRIV_REF); } catch { /* absent */ }
}

/** Derive the HKDF salt binding the wrap to both public keys. */
function seal_salt(ephemeralPubB64: string, recipientPubB64: string): Buffer {
  return Buffer.concat([Buffer.from(ephemeralPubB64, "base64"), Buffer.from(recipientPubB64, "base64")]);
}

/**
 * Seal `secret` to `recipientPubB64` so only the holder of the matching private
 * key can open it. Returns a base64 envelope. Anyone can call this — it needs
 * only the recipient's PUBLIC key.
 */
export function seal(secret: string, recipientPubB64: string): string {
  const recipient = pubFromB64(recipientPubB64);
  const eph = generateKeyPairSync("x25519");
  const ephPubB64 = pubToB64(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = Buffer.from(
    hkdfSync("sha256", shared, seal_salt(ephPubB64, recipientPubB64), SEAL_INFO, 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const env: Envelope = {
    v: 1,
    epk: ephPubB64,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
  return Buffer.from(JSON.stringify(env), "utf8").toString("base64");
}

/**
 * Open an envelope sealed to THIS machine's public key. Uses the private key in
 * the keychain. Throws if there's no identity, the envelope is malformed, or it
 * wasn't sealed to us (auth-tag failure).
 */
export function open(envelopeB64: string): string {
  const b64 = keychainGet(MEMBER_PRIV_REF);
  if (!b64) throw new Error("no team identity on this machine — run `stm teams enroll-request` first");
  return openWith(envelopeB64, b64);
}

/** Open an envelope with an explicitly-provided private key (PKCS8 DER, b64).
 *  Pure — `open()` is this plus the keychain lookup. */
export function openWith(envelopeB64: string, privateKeyB64: string): string {
  const priv = privFromB64(privateKeyB64);
  const myPubB64 = pubToB64(createPublicKey(priv));
  let env: Envelope;
  try {
    env = JSON.parse(Buffer.from(envelopeB64, "base64").toString("utf8")) as Envelope;
  } catch {
    throw new Error("malformed enrollment envelope");
  }
  if (env?.v !== 1 || !env.epk || !env.iv || !env.tag || !env.ct) {
    throw new Error("unrecognized enrollment envelope");
  }
  const shared = diffieHellman({ privateKey: priv, publicKey: pubFromB64(env.epk) });
  const key = Buffer.from(hkdfSync("sha256", shared, seal_salt(env.epk, myPubB64), SEAL_INFO, 32));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]);
  return pt.toString("utf8");
}
