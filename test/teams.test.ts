// STM Teams — server auth/zero-knowledge + a full client sync round-trip.
//
// The load-bearing property under test: a credential pushed to the team server
// is END-TO-END encrypted with a team passphrase the server never receives, so
// the stored blob is ciphertext the server structurally cannot read. A teammate
// with the passphrase pulls and decrypts locally.
//
// The client is driven with an injected `fetch` wired straight to the server
// handler (no port bind), and an injected in-memory store (no keychain), so the
// test is fast and platform-independent.

import { test, expect } from "bun:test";
import { TeamServerStore, makeTeamServerHandler } from "../src/teams/server.ts";
import {
  createTeam, pushVault, pullVault, generateTeamKey,
  registerMember, listMembers, getMember, uploadEnvelope, fetchEnvelope,
  pushLocalAudit, fetchTeamAudit,
  type TeamConfig,
} from "../src/teams/client.ts";
import { generateIdentity, seal, openWith } from "../src/teams/keypair.ts";
import { sign as edSign } from "../src/teams/signing.ts";
import { decryptVault } from "../src/keystores/encrypted-file.ts";

const ADMIN = "admin-token-abc";

/** Wire client fetch straight to a server handler (no network). */
function wire(store: TeamServerStore) {
  const handler = makeTeamServerHandler({ store, adminToken: ADMIN });
  const f = ((url: any, init: any) => handler(new Request(String(url), init))) as typeof fetch;
  return f;
}

/** Minimal in-memory stand-in for Store — just what the client touches. */
class FakeStore {
  private vals = new Map<string, string>();
  private meta: { tool: string; label: string; status: string }[] = [];
  seed(tool: string, label: string, value: string) {
    this.vals.set(`${tool}:${label}`, value);
    this.meta.push({ tool, label, status: "active" });
  }
  listKeys() {
    return this.meta.map((m) => ({
      tool: m.tool, label: m.label, status: m.status,
      tool_display: m.tool, placeholder: `{{stm:${m.tool}:${m.label}}}`,
      source: "manual", created_at: "",
    }));
  }
  resolve(tool: string, label: string) {
    return this.vals.get(`${tool}:${label}`) ?? null;
  }
  addKey({ tool, label, value }: { tool: string; label: string; value: string }) {
    const k = `${tool}:${label}`;
    if (this.vals.has(k)) throw new Error("already exists");
    this.vals.set(k, value);
    this.meta.push({ tool, label, status: "active" });
    return { placeholder: `{{stm:${tool}:${label}}}` };
  }
  private auditRows: any[] = [];
  seedAudit(event: string, tool: string, label: string, command: string) {
    this.auditRows.push({
      id: this.auditRows.length + 1, ts: "2026-01-01T00:00:00Z",
      event, tool, label, command, agent: "claude-code",
    });
  }
  listAuditForSync(since: number, limit: number) {
    return this.auditRows.filter((r) => r.id > since).slice(0, limit);
  }
}

const asStore = (f: FakeStore) => f as unknown as import("../src/store.ts").Store;

/** A full member: identity (seal + sign keys) + a signer over its Ed25519 key
 *  (no keychain — the private key is held in-test). */
function makeMember() {
  const id = generateIdentity();
  return { id, auth: { memberId: id.memberId, sign: (p: string) => edSign(p, id.signPrivateKeyB64) } };
}
async function register(cfg: TeamConfig, id: ReturnType<typeof generateIdentity>, f: typeof fetch) {
  await registerMember(cfg, id.memberId, id.sealPublicKeyB64, id.signPublicKeyB64, { fetch: f });
}

test("team creation requires the admin token", async () => {
  const store = new TeamServerStore();
  const handler = makeTeamServerHandler({ store, adminToken: ADMIN });
  const noAuth = await handler(new Request("http://s/v1/teams", {
    method: "POST", body: JSON.stringify({ name: "x" }),
  }));
  expect(noAuth.status).toBe(401);
  const wrong = await handler(new Request("http://s/v1/teams", {
    method: "POST", headers: { authorization: "Bearer nope" }, body: JSON.stringify({ name: "x" }),
  }));
  expect(wrong.status).toBe(401);
  store.close();
});

test("creation is disabled entirely when no admin token is configured", async () => {
  const store = new TeamServerStore();
  const handler = makeTeamServerHandler({ store }); // no adminToken
  const r = await handler(new Request("http://s/v1/teams", {
    method: "POST", headers: { authorization: "Bearer anything" }, body: JSON.stringify({ name: "x" }),
  }));
  expect(r.status).toBe(403);
  store.close();
});

test("vault + audit reject a bad/absent team token", async () => {
  const store = new TeamServerStore();
  const handler = makeTeamServerHandler({ store, adminToken: ADMIN });
  for (const path of ["/v1/vault", "/v1/audit"]) {
    const r = await handler(new Request(`http://s${path}`, { headers: { authorization: "Bearer bad" } }));
    expect(r.status).toBe(401);
  }
  store.close();
});

test("full round-trip: push encrypted, pull decrypts; server holds only ciphertext", async () => {
  const server = new TeamServerStore();
  const f = wire(server);
  const passphrase = "correct horse battery staple";

  // Admin creates a team.
  const team = await createTeam("http://s", ADMIN, "acme", { fetch: f });
  const cfg: TeamConfig = { serverUrl: "http://s", teamToken: team.token, teamId: team.id };

  // Machine A pushes two keys.
  const SECRET = "sk-live-SUPERSECRET-donotleak-0123456789";
  const src = new FakeStore();
  src.seed("openai", "default", "sk-openai-AAAA1111BBBB2222");
  src.seed("stripe", "default", SECRET);
  const pushed = await pushVault({ store: asStore(src), cfg, passphrase, actor: "alice", fetch: f });
  expect(pushed.keyCount).toBe(2);
  expect(pushed.version).toBe(1);

  // ZERO-KNOWLEDGE: the blob the server stored does NOT contain the plaintext,
  // and only the right passphrase decrypts it.
  const stored = server.getVault(team.id)!;
  const asText = Buffer.from(stored.ciphertext).toString("latin1");
  expect(asText).not.toContain(SECRET);
  expect(() => decryptVault(Buffer.from(stored.ciphertext), "wrong-passphrase")).toThrow();
  const round = JSON.parse(decryptVault(Buffer.from(stored.ciphertext), passphrase));
  expect(round.keys).toHaveLength(2);

  // Machine B (empty) pulls and gets both keys.
  const dst = new FakeStore();
  const pulled = await pullVault({ store: asStore(dst), cfg, passphrase, fetch: f });
  expect(pulled.added).toBe(2);
  expect(pulled.skipped).toBe(0);
  expect(dst.resolve("stripe", "default")).toBe(SECRET);

  // Pulling again is idempotent — both now already exist locally.
  const again = await pullVault({ store: asStore(dst), cfg, passphrase, fetch: f });
  expect(again.added).toBe(0);
  expect(again.skipped).toBe(2);

  server.close();
});

test("pull with the wrong passphrase fails loudly, adds nothing", async () => {
  const server = new TeamServerStore();
  const f = wire(server);
  const team = await createTeam("http://s", ADMIN, "acme", { fetch: f });
  const cfg: TeamConfig = { serverUrl: "http://s", teamToken: team.token };

  const src = new FakeStore();
  src.seed("openai", "default", "sk-openai-value-1234567890");
  await pushVault({ store: asStore(src), cfg, passphrase: "right", fetch: f });

  const dst = new FakeStore();
  await expect(
    pullVault({ store: asStore(dst), cfg, passphrase: "wrong", fetch: f }),
  ).rejects.toThrow(/passphrase/);
  expect(dst.listKeys()).toHaveLength(0);
  server.close();
});

test("audit POST requires a valid member signature; actor is the VERIFIED member", async () => {
  const server = new TeamServerStore();
  const f = wire(server);
  const team = await createTeam("http://s", ADMIN, "acme", { fetch: f });
  const cfg: TeamConfig = { serverUrl: "http://s", teamToken: team.token };
  const H = { authorization: `Bearer ${team.token}`, "content-type": "application/json" };

  // Unsigned post is rejected (the forgeable-actor gap is closed).
  const unsigned = await f("http://s/v1/audit", {
    method: "POST", headers: H,
    body: JSON.stringify({ rows: [{ event: "broker", detail: "x" }] }),
  });
  expect(unsigned.status).toBe(401);

  // A registered member signs a report; the server attributes it to THEM even
  // though the row claims a different actor.
  const { id, auth } = makeMember();
  await register(cfg, id, f);
  const body = JSON.stringify({ rows: [{ event: "broker", actor: "i-am-mallory", detail: "GET /v1/models -> 200" }] });
  const ts = new Date().toISOString();
  const nonce = "n1";
  const { createHash } = await import("node:crypto");
  const bodyHash = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
  const sigHdrs = {
    "x-stm-member": id.memberId,
    "x-stm-timestamp": ts,
    "x-stm-nonce": nonce,
    "x-stm-signature": auth.sign(`POST\n/v1/audit\n${ts}\n${nonce}\n${bodyHash}`),
  };
  const post = await f("http://s/v1/audit", { method: "POST", headers: { ...H, ...sigHdrs }, body });
  const pj = await post.json();
  expect(pj.added).toBe(1);
  expect(pj.actor).toBe(id.memberId);

  const rows = (await (await f("http://s/v1/audit?limit=10", { headers: { authorization: `Bearer ${team.token}` } })).json()).rows;
  expect(rows[0].actor).toBe(id.memberId); // verified id, NOT "i-am-mallory"
  server.close();
});

test("public-key enrollment: a new member gets the team key without a shared passphrase", async () => {
  const server = new TeamServerStore();
  const f = wire(server);
  const team = await createTeam("http://s", ADMIN, "acme", { fetch: f });
  const cfg: TeamConfig = { serverUrl: "http://s", teamToken: team.token, teamId: team.id };
  const df = { fetch: f };

  // Admin: generate the team key, self-enroll, push an encrypted vault.
  const teamKey = generateTeamKey();
  const admin = generateIdentity();
  await register(cfg, admin, f);
  await uploadEnvelope(cfg, admin.memberId, seal(teamKey, admin.sealPublicKeyB64), df);
  const src = new FakeStore();
  src.seed("openai", "default", "sk-openai-shared-team-key-000111");
  await pushVault({ store: asStore(src), cfg, passphrase: teamKey, fetch: f });

  // New member: request enrollment (publishes only PUBLIC keys).
  const member = generateIdentity();
  await register(cfg, member, f);

  // Server shows the member pending (no wrapped key yet).
  let members = await listMembers(cfg, df);
  expect(members.find((m) => m.memberId === member.memberId)!.enrolled).toBe(false);
  expect(await fetchEnvelope(cfg, member.memberId, df)).toBeNull(); // nothing to accept yet

  // Admin enrolls the member: seal the team key to THEIR sealing key + upload.
  const theirPub = (await getMember(cfg, member.memberId, df))!.pubkey;
  await uploadEnvelope(cfg, member.memberId, seal(teamKey, theirPub), df);

  members = await listMembers(cfg, df);
  expect(members.find((m) => m.memberId === member.memberId)!.enrolled).toBe(true);

  // Member accepts: unwrap with THEIR sealing private key -> the same team key.
  const envelope = (await fetchEnvelope(cfg, member.memberId, df))!;
  const recovered = openWith(envelope, member.sealPrivateKeyB64);
  expect(recovered).toBe(teamKey);

  // And with it, the member can pull + decrypt the vault.
  const dst = new FakeStore();
  const pulled = await pullVault({ store: asStore(dst), cfg, passphrase: recovered, fetch: f });
  expect(pulled.added).toBe(1);
  expect(dst.resolve("openai", "default")).toBe("sk-openai-shared-team-key-000111");

  // The team key was NEVER sent in the clear: every envelope is ciphertext that
  // only the addressed private key opens.
  const outsider = generateIdentity();
  expect(() => openWith(envelope, outsider.sealPrivateKeyB64)).toThrow();

  server.close();
});

test("server rejects a pubkey registered under a mismatched member id (identity substitution)", async () => {
  const server = new TeamServerStore();
  const f = wire(server);
  const team = await createTeam("http://s", ADMIN, "acme", { fetch: f });
  const cfg: TeamConfig = { serverUrl: "http://s", teamToken: team.token };
  const H = { authorization: `Bearer ${team.token}`, "content-type": "application/json" };

  const alice = generateIdentity();
  const mallory = generateIdentity();
  await register(cfg, alice, f); // legit

  // Mallory tries to overwrite Alice's id with HER keys -> server refuses (400).
  const r = await f("http://s/v1/members", {
    method: "POST", headers: H,
    body: JSON.stringify({ memberId: alice.memberId, pubkey: mallory.sealPublicKeyB64, signPubkey: mallory.signPublicKeyB64 }),
  });
  expect(r.status).toBe(400);
  // Alice's stored key is untouched, so a later enroll still seals to Alice.
  const m = await getMember(cfg, alice.memberId, { fetch: f });
  expect(m!.pubkey).toBe(alice.sealPublicKeyB64);
  server.close();
});

test("server caps oversized pubkey and envelope (DoS)", async () => {
  const server = new TeamServerStore();
  const f = wire(server);
  const team = await createTeam("http://s", ADMIN, "acme", { fetch: f });
  const cfg: TeamConfig = { serverUrl: "http://s", teamToken: team.token };
  const H = { authorization: `Bearer ${team.token}`, "content-type": "application/json" };

  const big = await f("http://s/v1/members", {
    method: "POST", headers: H,
    body: JSON.stringify({ memberId: "x", pubkey: "A".repeat(3000), signPubkey: "B" }),
  });
  expect(big.status).toBe(413);

  const alice = generateIdentity();
  await register(cfg, alice, f);
  const bigEnv = await f(`http://s/v1/members/${alice.memberId}/envelope`, {
    method: "POST", headers: H, body: JSON.stringify({ envelope: "B".repeat(70000) }),
  });
  expect(bigEnv.status).toBe(413);
  server.close();
});

test("team audit: local key-use events push once (cursor advances) and are visible team-wide", async () => {
  const server = new TeamServerStore();
  const f = wire(server);
  const team = await createTeam("http://s", ADMIN, "acme", { fetch: f });
  const cfg: TeamConfig = { serverUrl: "http://s", teamToken: team.token, teamId: team.id };

  // A registered member with a signing identity pushes their local events.
  const { id: alice, auth } = makeMember();
  await register(cfg, alice, f);

  const src = new FakeStore();
  src.seedAudit("substitute", "openai", "default", "curl -H 'auth: {{stm:openai:default}}' api");
  src.seedAudit("policy.deny", "fal", "default", "echo {{stm:fal:default}}");

  const r1 = await pushLocalAudit({ store: asStore(src), cfg, auth, fetch: f });
  expect(r1.pushed).toBe(2);
  expect(r1.cursor).toBe(2);

  const rows = await fetchTeamAudit(r1.cfg, 10, { fetch: f });
  expect(rows).toHaveLength(2);
  // The actor is the VERIFIED member id (derived from the signature), not claimed.
  expect(rows.every((x) => x.actor === alice.memberId)).toBe(true);
  // The detail is the PLACEHOLDER command — no resolved secret ever left the box.
  expect(rows.some((x) => String(x.detail).includes("{{stm:openai:default}}"))).toBe(true);

  // Re-pushing with the advanced cursor sends nothing (idempotent).
  const r2 = await pushLocalAudit({ store: asStore(src), cfg: r1.cfg, auth, fetch: f });
  expect(r2.pushed).toBe(0);

  // A new local event pushes just the one.
  src.seedAudit("substitute", "stripe", "default", "curl {{stm:stripe:default}}");
  const r3 = await pushLocalAudit({ store: asStore(src), cfg: r1.cfg, auth, fetch: f });
  expect(r3.pushed).toBe(1);
  expect((await fetchTeamAudit(r3.cfg, 10, { fetch: f }))).toHaveLength(3);

  server.close();
});
