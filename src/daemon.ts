// The localhost dashboard daemon.
//
// A singleton HTTP service bound to 127.0.0.1 that owns the dashboard web UI
// and the JSON API behind it. Security posture:
//   - loopback bind (127.0.0.1) only
//   - a per-run random auth token, required on every /api call and on GET /
//   - Host / Origin allowlist — defense against DNS-rebinding
// The daemon deliberately outlives a single Claude Code session so concurrent
// sessions share one instance; `stm stop` ends it.
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "./store.ts";
import { activeKeyStore } from "./keychain.ts";
import { DAEMON_FILE, ensureDataDir } from "./paths.ts";
import { dashboardHTML } from "./dashboard.ts";
import { importSelected, scanEnv } from "./import.ts";
import { evaluateAll, type PolicyAction } from "./policy.ts";
import { findExact } from "./grammar.ts";
import { syncAll, syncProvider } from "./sync.ts";
import { listProviderIds } from "./providers/index.ts";
import { listSupportedAgents } from "./agents/codex.ts";

interface DaemonInfo {
  port: number;
  token: string;
  pid: number;
}

function readInfo(): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(DAEMON_FILE, "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

function writeInfo(info: DaemonInfo): void {
  ensureDataDir();
  // Unlink any existing descriptor first: avoids a umask-widened permission
  // window before the chmod, and refuses to follow a symlink planted there.
  try {
    unlinkSync(DAEMON_FILE);
  } catch {
    /* not present */
  }
  writeFileSync(DAEMON_FILE, JSON.stringify(info), { mode: 0o600 });
  try {
    chmodSync(DAEMON_FILE, 0o600);
  } catch {
    /* best-effort */
  }
}

function clearInfo(): void {
  try {
    unlinkSync(DAEMON_FILE);
  } catch {
    /* already gone */
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function reachable(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** The descriptor of a daemon that is actually alive, or null. */
async function liveInfo(): Promise<DaemonInfo | null> {
  const info = readInfo();
  if (!info) return null;
  if (!pidAlive(info.pid)) {
    clearInfo();
    return null;
  }
  if (!(await reachable(info.port))) return null;
  return info;
}

const SEC_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...SEC_HEADERS },
  });
}

/** Host/Origin allowlist — rejects DNS-rebinding and cross-origin callers. */
function hostOk(req: Request): boolean {
  const host = req.headers.get("host") ?? "";
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  const origin = req.headers.get("origin");
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    return false;
  }
  return true;
}

async function apiRoute(path: string, req: Request, store: Store): Promise<Response> {
  if (path === "/api/inventory" && req.method === "GET") {
    let keystore: string;
    try { keystore = activeKeyStore().describe(); }
    catch (e: any) { keystore = `unresolved: ${e?.message ?? e}`; }
    return json({
      tools: store.listTools(),
      keys: store.listKeys(),
      monthlySpend: store.monthlySpend(),
      monthlySpendBreakdown: store.monthlySpendBreakdown(),
      spend: store.listSpend(),
      providers: listProviderIds(),
      keystore,
      agents: listSupportedAgents(),
    });
  }
  if (path === "/api/keys" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    if (!b.tool || !b.value) {
      return json({ error: "tool and value are required" }, 400);
    }
    if (b.plan != null || b.cost != null || b.renews != null || b.display) {
      store.upsertTool({
        name: b.tool,
        displayName: b.display ?? undefined,
        plan: b.plan ?? null,
        monthlyCost: b.cost != null ? Number(b.cost) : null,
        renewsOn: b.renews ?? null,
      });
    }
    try {
      const k = store.addKey({
        tool: b.tool,
        label: b.label || "default",
        value: String(b.value),
        source: "manual",
        displayName: b.display ?? undefined,
      });
      return json({ ok: true, placeholder: k.placeholder });
    } catch (e: any) {
      return json({ error: e?.message ?? String(e) }, 400);
    }
  }
  if (path === "/api/keys/revoke" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    return store.revokeKey(b.tool, b.label)
      ? json({ ok: true })
      : json({ error: "no such key" }, 404);
  }
  if (path === "/api/tools/subscription" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    if (!b.tool) return json({ error: "tool is required" }, 400);
    const cost =
      b.cost != null && b.cost !== "" && Number.isFinite(Number(b.cost))
        ? Number(b.cost)
        : null;
    const ok = store.setSubscription({
      name: b.tool,
      plan: b.plan ? String(b.plan) : null,
      monthlyCost: cost,
      renewsOn: b.renews ? String(b.renews) : null,
    });
    return ok ? json({ ok: true }) : json({ error: "no such tool" }, 404);
  }
  if (path === "/api/import/scan" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    const dirs = Array.isArray(b.dirs) && b.dirs.length ? b.dirs : [process.cwd()];
    return json({ candidates: scanEnv(dirs) });
  }
  if (path === "/api/import/confirm" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    const cwd = typeof b?.cwd === "string" && b.cwd ? b.cwd : undefined;
    return json(
      importSelected(Array.isArray(b.selections) ? b.selections : [], { cwd }),
    );
  }

  // ---- command policy (spec: specs/command-policy.md, Phase 2) -----------

  if (path === "/api/policies" && req.method === "GET") {
    return json({ policies: store.listPolicies() });
  }
  if (path === "/api/policies" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    const action = b.action;
    if (action !== "allow" && action !== "deny" && action !== "warn") {
      return json({ error: "action must be allow, deny, or warn" }, 400);
    }
    const order = b.ordering != null && b.ordering !== "" ? Number(b.ordering) : undefined;
    if (order !== undefined && !Number.isFinite(order)) {
      return json({ error: "ordering must be a number" }, 400);
    }
    try {
      const rule = store.addPolicy({
        ordering: order,
        whenKey: b.whenKey ?? null,
        whenCommand: b.whenCommand ?? null,
        whenAgent: b.whenAgent ?? null,
        whenProject: b.whenProject ?? null,
        action: action as PolicyAction,
        reason: b.reason ?? null,
      });
      return json({ policy: rule });
    } catch (e: any) {
      return json({ error: e?.message ?? String(e) }, 400);
    }
  }
  {
    const m = path.match(/^\/api\/policies\/(\d+)$/);
    if (m && req.method === "DELETE") {
      const id = Number(m[1]);
      return store.removePolicy(id)
        ? json({ ok: true })
        : json({ error: "no such policy" }, 404);
    }
  }
  if (path === "/api/policies/test" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    const command: string = typeof b.command === "string" ? b.command : "";
    if (!command) return json({ error: "command is required" }, 400);
    const exact = findExact(command);
    if (exact.length === 0) {
      return json({
        action: "allow",
        rule: null,
        reason: null,
        perKey: [],
        note: "No stm placeholders in this command — policy not consulted.",
      });
    }
    const keys = [...new Set(exact.map((p) => `${p.tool}:${p.label}`))];
    // Optional `cwd` lets the dashboard simulate "what would PreToolUse do
    // for this command, running inside this directory?". Falls back to "no
    // project" so a missing field is the historical behaviour.
    const cwd: string = typeof b.cwd === "string" && b.cwd ? b.cwd : "";
    const project = cwd ? store.matchProject(cwd) : null;
    const decision = evaluateAll(
      store.listPolicies(),
      command,
      "claude-code",
      keys,
      project?.name ?? "",
    );
    return json(decision);
  }

  // Phase 3: per-project scope-enforcement toggle.
  {
    const m = path.match(/^\/api\/projects\/(\d+)\/enforce$/);
    if (m && req.method === "POST") {
      const id = Number(m[1]);
      const b: any = await req.json().catch(() => ({}));
      if (typeof b?.on !== "boolean") {
        return json({ error: "body must be { on: boolean }" }, 400);
      }
      const ok = store.setEnforceScope(id, b.on);
      return ok
        ? json({ ok: true, enforce_scope: b.on ? 1 : 0 })
        : json({ error: "no such project" }, 404);
    }
  }

  // ---- projects CRUD + scope (spec: session-and-project-scope.md Phase 2)

  /**
   * Build a "project + scope" view object — everything the dashboard
   * Projects card needs to render one row in one fetch. Returns:
   *   { id, path, name, enforce_scope, created_at,
   *     scope: [{ tool, label, placeholder }, ...] }
   */
  function projectView(p: ReturnType<Store["getProject"]>) {
    if (!p) return null;
    return { ...p, scope: store.projectScope(p.id) };
  }

  if (path === "/api/projects" && req.method === "GET") {
    const projects = store.listProjects();
    return json({
      projects: projects.map((p) => projectView(p)),
    });
  }
  if (path === "/api/projects" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    if (typeof b?.path !== "string" || !b.path.trim()) {
      return json({ error: "path is required" }, 400);
    }
    if (typeof b?.name !== "string" || !b.name.trim()) {
      return json({ error: "name is required" }, 400);
    }
    try {
      const p = store.addProject({ path: b.path, name: b.name });
      return json({ project: projectView(p) });
    } catch (e: any) {
      return json({ error: e?.message ?? String(e) }, 400);
    }
  }
  /**
   * Match the longest-prefix project for a given cwd — used by the
   * dashboard's `?from=<cwd>` header signal. Returns the matched project
   * (or null) PLUS a normalized form of the cwd, so the UI can show a
   * canonical path and offer "Create project from this path".
   */
  if (path === "/api/projects/match" && req.method === "GET") {
    const u = new URL(req.url);
    const cwd = (u.searchParams.get("cwd") ?? "").trim();
    if (!cwd) return json({ project: null, cwd: "" });
    let normalized = cwd;
    try {
      // Reuse the same normalization the store applies on writes so the
      // UI's "create project from this path" round-trip is idempotent.
      const { normalizeProjectPath } = await import("./store.ts");
      normalized = normalizeProjectPath(cwd);
    } catch {
      /* fall back to raw cwd */
    }
    const p = store.matchProject(cwd);
    return json({ project: projectView(p), cwd: normalized });
  }
  {
    const m = path.match(/^\/api\/projects\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (req.method === "GET") {
        const p = store.getProject(id);
        return p ? json({ project: projectView(p) }) : json({ error: "no such project" }, 404);
      }
      if (req.method === "PATCH") {
        const b: any = await req.json().catch(() => ({}));
        if (typeof b?.name !== "string" || !b.name.trim()) {
          return json({ error: "name is required" }, 400);
        }
        const ok = store.renameProject(id, b.name);
        return ok
          ? json({ project: projectView(store.getProject(id)) })
          : json({ error: "no such project" }, 404);
      }
      if (req.method === "DELETE") {
        return store.removeProject(id)
          ? json({ ok: true })
          : json({ error: "no such project" }, 404);
      }
    }
  }
  {
    const m = path.match(/^\/api\/projects\/(\d+)\/scope$/);
    if (m) {
      const id = Number(m[1]);
      const p = store.getProject(id);
      if (!p) return json({ error: "no such project" }, 404);
      if (req.method === "POST") {
        const b: any = await req.json().catch(() => ({}));
        if (typeof b?.tool !== "string" || typeof b?.label !== "string") {
          return json({ error: "tool and label are required" }, 400);
        }
        try {
          store.addProjectScope(id, b.tool, b.label);
          return json({ project: projectView(store.getProject(id)) });
        } catch (e: any) {
          return json({ error: e?.message ?? String(e) }, 400);
        }
      }
      if (req.method === "DELETE") {
        const b: any = await req.json().catch(() => ({}));
        if (typeof b?.tool !== "string" || typeof b?.label !== "string") {
          return json({ error: "tool and label are required" }, 400);
        }
        const ok = store.removeProjectScope(id, b.tool, b.label);
        return ok
          ? json({ project: projectView(store.getProject(id)) })
          : json({ error: "(tool, label) not in scope" }, 404);
      }
    }
  }

  // ---- audit log (spec: specs/audit-log.md, Phase 4) ---------------------

  if (path === "/api/audit" && req.method === "GET") {
    const u = new URL(req.url);
    const limitRaw = Number(u.searchParams.get("limit") ?? "20");
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(Math.floor(limitRaw), 500))
      : 20;
    const event = u.searchParams.get("event") || undefined;
    if (
      event !== undefined &&
      !["substitute", "policy.deny", "policy.warn", "unresolved", "malformed"].includes(event)
    ) {
      return json({ error: "unknown event class" }, 400);
    }
    const tool = u.searchParams.get("tool") || undefined;
    return json({
      rows: store.listAudit({ limit, event: event as any, tool }),
      count: store.auditCount(),
    });
  }
  if (path === "/api/audit/clear" && req.method === "POST") {
    const removed = store.clearAudit();
    return json({ ok: true, removed });
  }

  // ---- spend visibility (spec: specs/spend-visibility.md) ----------------
  //
  // NETWORK POSTURE RULE (§2 of the spec, surfaced verbatim wherever
  // sync is exposed): stm makes outbound network calls only when the
  // USER initiates a sync via this endpoint or `stm sync`. No
  // background activity, no telemetry, no phone-home. The auth token
  // + Host/Origin allowlist (which already gate every /api/ call)
  // mean a third party cannot trigger this even on the same host.

  if (path === "/api/spend" && req.method === "GET") {
    return json({
      rows: store.listSpend(),
      breakdown: store.monthlySpendBreakdown(),
      providers: listProviderIds(),
    });
  }
  if (path === "/api/spend/sync" && req.method === "POST") {
    const b: any = await req.json().catch(() => ({}));
    // Pass our long-lived store handle into the orchestrator so the
    // sync doesn't open a second SQLite connection per request.
    if (typeof b?.provider === "string" && b.provider) {
      const r = await syncProvider(b.provider, { store });
      if (!r) return json({ error: `unknown provider: ${b.provider}` }, 400);
      return json({ results: [r] });
    }
    const results = await syncAll({ store });
    return json({ results });
  }

  return json({ error: "not found" }, 404);
}

/** Run the daemon in the foreground (the process is `stm daemon`). */
export async function runDaemon(): Promise<void> {
  const live = await liveInfo();
  if (live) {
    process.stderr.write(
      `subscribetome daemon already running on port ${live.port}\n`,
    );
    process.exit(0);
  }

  const token = randomBytes(24).toString("hex");
  const store = new Store();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      // Liveness probe — no auth, no host check, leaks nothing.
      if (path === "/api/health") return json({ ok: true });

      if (!hostOk(req)) {
        return new Response("forbidden", { status: 403, headers: SEC_HEADERS });
      }

      const tok =
        req.headers.get("x-stm-token") ?? url.searchParams.get("token") ?? "";
      const authed = tok === token;

      if (path === "/") {
        if (!authed) {
          return new Response(
            "unauthorized - open the URL printed by `stm dashboard`",
            { status: 403, headers: SEC_HEADERS },
          );
        }
        return new Response(dashboardHTML(), {
          headers: { "content-type": "text/html; charset=utf-8", ...SEC_HEADERS },
        });
      }
      if (path.startsWith("/api/")) {
        if (!authed) return json({ error: "unauthorized" }, 401);
        return apiRoute(path, req, store);
      }
      return new Response("not found", { status: 404, headers: SEC_HEADERS });
    },
  });

  // Narrow the singleton race: if another daemon went live between the
  // initial check and now, defer to it and shut this one down.
  const raced = await liveInfo();
  if (raced) {
    server.stop(true);
    store.close();
    process.stderr.write(
      `another subscribetome daemon is already live (port ${raced.port}); exiting\n`,
    );
    process.exit(0);
  }
  writeInfo({ port: server.port, token, pid: process.pid });
  process.stderr.write(
    `subscribetome daemon on http://127.0.0.1:${server.port}/?token=${token}\n`,
  );

  const shutdown = () => {
    clearInfo();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function cliPath(): string {
  return join(import.meta.dir, "cli.ts");
}

/** Ensure the daemon is up, print the dashboard URL, open a browser. */
export async function openDashboard(): Promise<void> {
  let info = await liveInfo();
  if (!info) {
    const child = Bun.spawn([process.execPath, cliPath(), "daemon"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    child.unref();
    for (let i = 0; i < 50 && !info; i++) {
      await Bun.sleep(100);
      info = await liveInfo();
    }
    if (!info) {
      process.stderr.write("failed to start the dashboard daemon\n");
      process.exit(1);
    }
  }
  // The token-bearing URL goes ONLY to the browser via `open`. stdout may be
  // captured into a terminal transcript or an agent's conversation, so the
  // token must never be printed there.
  //
  // Phase 2 of session-and-project-scope: pass the current cwd as
  // `?from=<encoded>` so the dashboard can render its "Session in <name>"
  // header signal. The dashboard fetches /api/projects/match?cwd= and
  // either resolves it to a registered project or offers a one-click
  // "Create project from this path" affordance. Failing silently here
  // (no STM_CWD env override etc.) is fine — the dashboard renders
  // without the signal and the user can still use Browse/Projects.
  const fromParam = `&from=${encodeURIComponent(process.cwd())}`;
  const tokenUrl = `http://127.0.0.1:${info.port}/?token=${info.token}${fromParam}`;
  process.stdout.write(
    `dashboard: http://127.0.0.1:${info.port}/  (opening in your browser)\n`,
  );
  spawnSync("open", [tokenUrl]);
}

export async function stopDaemon(): Promise<void> {
  const info = readInfo();
  if (!info) {
    process.stdout.write("daemon not running\n");
    return;
  }
  if (pidAlive(info.pid)) {
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    process.stdout.write(`stopped daemon (pid ${info.pid})\n`);
  } else {
    process.stdout.write("daemon not running (cleared stale descriptor)\n");
  }
  clearInfo();
}

export async function printStatus(): Promise<void> {
  const info = await liveInfo();
  const store = new Store();
  try {
    const keys = store.listKeys();
    // Resolve the active KeyStore so the user always sees where keys
    // actually live. Specs/cross-platform-and-codex.md §4.1: the spec
    // mandates this never be hidden.
    let backend: string;
    try {
      backend = activeKeyStore().describe();
    } catch (e: any) {
      backend = `error resolving keystore: ${e?.message ?? e}`;
    }
    // Agents row — names every wrapper stm ships today, in stable
    // order. Specs/cross-platform-and-codex.md §6 calls out that the
    // active agent label (and security framing) must never be hidden
    // from the user. We render it here as well as in the dashboard
    // pill so CLI-only users see the same information.
    const agents = listSupportedAgents()
      .map((a) => a.label)
      .join(" · ");
    process.stdout.write(
      `daemon   : ${info ? `running - http://127.0.0.1:${info.port}` : "not running"}\n` +
        `keystore : ${backend}\n` +
        `agents   : ${agents}\n` +
        `keys     : ${keys.length} (${keys.filter((k) => k.status === "active").length} active)\n` +
        `tools    : ${store.listTools().length}\n` +
        `spend    : $${store.monthlySpend().toFixed(2)} / month\n`,
    );
  } finally {
    store.close();
  }
}
