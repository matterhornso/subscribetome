import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { selectedSecretsRoute } from "../src/selected-secrets.ts";

// Explicit opt-in cross-repository contract check, using the real HTTP handler
// and adapter but ONLY an in-memory secret store. Never opens a real STM vault.
const adapterPath = process.env.MATTERHORN_STM_ADAPTER_PATH;
test.skipIf(!adapterPath)("Matterhorn adapter interoperates over loopback with selected STM route", async () => {
  if (!adapterPath) throw new Error("adapter path required");
  const { StmCredentials, spawnStmConsumer } = await import(pathToFileURL(adapterPath).href);
  const dir = await mkdtemp(join(tmpdir(), "stm-matterhorn-contract-"));
  const token = "b".repeat(48);
  const reads: string[] = [];
  const store = {
    listKeys: () => [{ tool: "fixture", label: "default", status: "active", created_at: "2026-09-28" }],
    viewKey: (tool: string) => tool === "fixture" ? { status: "active" } : null,
    resolve: (tool: string) => { reads.push(tool); return "disposable-contract-value"; },
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: req => selectedSecretsRoute(req, token, store, () => "in-memory contract fixture"),
  });
  try {
    const descriptorPath = join(dir, "daemon.json");
    await writeFile(descriptorPath, JSON.stringify({ port: server.port, pid: process.pid, token }), { mode: 0o600 });
    const adapter = new StmCredentials({ enabled: true, localDesktop: true, platform: "darwin", descriptorPath, registryPath: join(dir, "bindings.json") });
    expect(await adapter.connect({ consent: true })).toEqual({ state: "connected", version: 1, backend: "in-memory contract fixture" });
    await adapter.link({ envName: "FIXTURE_API_KEY", tool: "fixture", label: "default", consumer: "mcp:fixture", consent: true });
    expect(reads).toEqual([]);
    const child = await spawnStmConsumer({ credentials: adapter, consumer: "mcp:fixture", command: process.execPath,
      args: ["-e", 'process.stdout.write(process.env.FIXTURE_API_KEY === "disposable-contract-value" ? "accepted" : "failed")'],
      inherited: {}, authorize: () => true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", (code: number) => code === 0 ? resolve() : reject(new Error("fixture failed"))); });
    expect(output).toBe("accepted");
    expect(reads).toEqual(["fixture"]);
    server.stop(true);
    await expect(adapter.resolveForConsumer("mcp:fixture")).rejects.toThrow("connection_failed");
    expect(await adapter.listBindings()).toHaveLength(1);
  } finally { server.stop(true); await rm(dir, { recursive: true, force: true }); }
});
