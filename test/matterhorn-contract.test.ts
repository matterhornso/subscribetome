import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { selectedSecretsRoute } from "../src/selected-secrets.ts";
import { Store } from "../src/store.ts";

// Explicit opt-in cross-repository contract check, using the real HTTP handler
// and adapter but ONLY an in-memory secret store. Never opens a real STM vault.
const adapterPath = process.env.MATTERHORN_STM_ADAPTER_PATH;
test.skipIf(!adapterPath)("Matterhorn adapter interoperates over loopback with selected STM route", async () => {
  if (!adapterPath) throw new Error("adapter path required");
  const { StmCredentials, spawnStmConsumer } = await import(pathToFileURL(adapterPath).href);
  const dir = await mkdtemp(join(tmpdir(), "stm-matterhorn-contract-"));
  const token = "b".repeat(48);
  let backend = "macOS Keychain";
  const reads: string[] = [];
  const store = {
    listSelectedKeys: () => [{ tool: "fixture", label: "default", status: "active", updatedAt: "2026-09-28", revision: "d".repeat(64) }],
    listKeys: () => [{ tool: "fixture", label: "default", status: "active", created_at: "2026-09-28" }],
    viewKey: (tool: string) => tool === "fixture" ? { status: "active" } : null,
    resolve: (tool: string) => { reads.push(tool); return "disposable-contract-value"; },
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    // Advertise the macOS protocol identity; storage remains entirely fake.
    fetch: req => selectedSecretsRoute(req, token, store, () => backend),
  });
  try {
    const descriptorPath = join(dir, "daemon.json");
    await writeFile(descriptorPath, JSON.stringify({ port: server.port, pid: process.pid, token }), { mode: 0o600 });
    const adapter = new StmCredentials({ enabled: true, localDesktop: true, platform: "darwin", descriptorPath, registryPath: join(dir, "bindings.json") });
    expect(await adapter.connect({ consent: true })).toEqual({ state: "connected", version: 1, backend: "macOS Keychain" });
    await adapter.link({ envName: "FIXTURE_API_KEY", tool: "fixture", label: "default", consumer: "mcp:fixture", consent: true });
    expect(reads).toEqual([]);
    const child = await spawnStmConsumer({ credentials: adapter, consumer: "mcp:fixture", command: process.execPath,
      args: ["-e", 'process.stdout.write(process.env.FIXTURE_API_KEY ? "accepted" : "failed")'],
      inherited: {}, authorize: () => true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", (code: number) => code === 0 ? resolve() : reject(new Error("fixture failed"))); });
    expect(output).toBe("accepted");
    expect(reads).toEqual(["fixture"]);
    backend = "unsupported (disposable test reason)";
    expect(await adapter.status()).toEqual({ state: "unavailable", code: "unsupported_keystore" });
    await expect(adapter.resolveForConsumer("mcp:fixture")).rejects.toThrow("unsupported_keystore");
    expect(reads).toEqual(["fixture"]);
    expect(await adapter.listBindings()).toHaveLength(1);
    server.stop(true);
    await expect(adapter.resolveForConsumer("mcp:fixture")).rejects.toThrow("connection_failed");
    expect(await adapter.listBindings()).toHaveLength(1);
  } finally { server.stop(true); await rm(dir, { recursive: true, force: true }); }
});

test.skipIf(!adapterPath)("Matterhorn revisioned writes interoperate with real STM inventory and fake keystore", async () => {
  if (!adapterPath) throw new Error("adapter path required");
  const { StmCredentials } = await import(pathToFileURL(adapterPath).href);
  const dir = await mkdtemp(join(tmpdir(), "stm-matterhorn-lifecycle-"));
  const token = "b".repeat(48);
  const values = new Map<string, string>();
  let keyReads = 0;
  const store = new Store(":memory:", { get: ref => { keyReads++; return values.get(ref) ?? null; }, set: (ref, value) => { values.set(ref, value); }, delete: ref => { values.delete(ref); } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => selectedSecretsRoute(req, token, store, () => "macOS Keychain") });
  try {
    const descriptorPath = join(dir, "daemon.json");
    await writeFile(descriptorPath, JSON.stringify({ port: server.port, pid: process.pid, token }), { mode: 0o600 });
    const adapter = new StmCredentials({ enabled: true, localDesktop: true, platform: "darwin", descriptorPath, registryPath: join(dir, "bindings.json") });
    await adapter.connect({ consent: true });
    const created = await adapter.saveCredential({ tool: "fixture", label: "default", value: "initial-disposable-value", expectedRevision: null, consent: true });
    expect(JSON.stringify(created)).not.toContain("initial-disposable-value");
    await adapter.link({ envName: "FIXTURE_API_KEY", tool: "fixture", label: "default", consumer: "mcp:fixture", consent: true });
    expect(await adapter.resolveForConsumer("mcp:fixture")).toEqual({ FIXTURE_API_KEY: "initial-disposable-value" });
    const replaced = await adapter.saveCredential({ tool: "fixture", label: "default", value: "replacement-disposable-value", expectedRevision: created.key.revision, consent: true });
    expect(replaced.key.revision).not.toBe(created.key.revision);
    expect(await adapter.resolveForConsumer("mcp:fixture")).toEqual({ FIXTURE_API_KEY: "replacement-disposable-value" });
    await expect(adapter.saveCredential({ tool: "fixture", label: "default", value: "must-not-win", expectedRevision: created.key.revision, consent: true })).rejects.toThrow("credential_revision_conflict");
    expect(values.size).toBe(1);
    const [binding] = await adapter.listBindings();
    expect(binding.credentialRevision).toBe(replaced.key.revision);
    expect(binding.restartRequired).toBe(true);
    await adapter.acknowledgeMcpStart("mcp:fixture", [binding.id], { FIXTURE_API_KEY: replaced.key.revision });
    expect((await adapter.refreshBindings()).items[0].restartRequired).toBe(false);
    store.rotateKey({ tool: "fixture", label: "default", newValue: "native-rotation-fixture" });
    const beforeRefresh = keyReads;
    const refreshed = await adapter.refreshBindings();
    expect(keyReads).toBe(beforeRefresh);
    expect(refreshed.items[0].credentialState).toBe("available");
    expect(refreshed.items[0].credentialRevision).not.toBe(replaced.key.revision);
    expect(refreshed.items[0].appliedRevision).toBe(replaced.key.revision);
    expect(refreshed.items[0].restartRequired).toBe(true);
    expect(JSON.stringify(refreshed)).not.toContain("native-rotation-fixture");
    store.revokeKey("fixture", "default");
    const revoked = await adapter.refreshBindings();
    expect(revoked.items[0].credentialState).toBe("revoked");
    expect(revoked.items[0].restartRequired).toBe(true);
    expect(keyReads).toBe(beforeRefresh);
    await expect(adapter.resolveForConsumer("mcp:fixture")).rejects.toThrow("request_failed");
  } finally { server.stop(true); store.close(); await rm(dir, { recursive: true, force: true }); }
});
