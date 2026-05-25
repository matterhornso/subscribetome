// Codex MCP server — v0.7.0 (specs/cross-platform-and-codex.md §6 Option 2).
//
// The premise (per the spec):
//   "Codex fully supports MCP servers, including an `env` table for
//    secrets. Instead of the agent running raw `curl ... Bearer
//    <key>`, expose an MCP tool (e.g. `call_api`) that subscribetome
//    runs; the MCP server reads the key from the KeyStore at startup.
//    The agent invokes a named tool and never handles the secret."
//
// Posture upgrade over Option 1 (session-env mode, v0.4.0):
//   Option 1 put the key in codex's process env for the whole
//   session — a command that dumped its environment could surface
//   it. THIS MODE leaves the key entirely inside stm's MCP-server
//   process. Codex (and its agent shells) never see the key value;
//   they invoke a named tool, and the server makes the upstream
//   HTTPS request on their behalf.
//
//   This is the structurally closest equivalent to Claude Code's
//   per-command rewrite that Codex can host today.
//
// Wire protocol: JSON-RPC 2.0 over stdio (the MCP local-transport
// standard). We implement the three methods Codex needs:
//   - initialize         (handshake, server capabilities)
//   - tools/list         (advertise stm_http_request)
//   - tools/call         (route to the upstream provider)
//
// ZERO RUNTIME DEPS — load-bearing project invariant. We do not
// pull in `@modelcontextprotocol/sdk`; the JSON-RPC wire format
// for our three methods is small enough to handle directly.
//
// SECURITY POSTURE (load-bearing):
//   - The credential value is read from the KeyStore at the moment
//     of each `tools/call` and used to populate one HTTP header on
//     the outbound request. It is NEVER:
//       * returned in the tool response
//       * logged to stderr (the MCP stderr channel is visible to
//         Codex as developer context)
//       * placed in any structured field of the JSON-RPC reply
//   - The MCP server runs in its own process under `stm codex
//     mcp-server`; Codex spawns it via `mcp_servers` config and
//     pipes stdio. There is no shared memory with codex; the key
//     simply never lives in codex's address space.

import { findProvider, buildAuthHeader, toolSchema, listProviderIds } from "./codex-mcp-providers.ts";
import type { McpProviderDef } from "./codex-mcp-providers.ts";

// ---- JSON-RPC types ----

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// JSON-RPC error codes — standard subset.
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;
// Per the MCP spec we can use the application range for tool-level
// failures; we surface upstream HTTP failures via the standard
// MCP `isError: true` content shape (see callTool below), so this
// one is only for our own validation.
const ERR_PROVIDER_NOT_FOUND = -32001;

// ---- request handlers ----

export interface ServerDeps {
  /**
   * KeyStore handle. We read the credential value via
   * `ks.get(<keychain_ref>)` — same surface the Store uses today.
   * Injected so tests can pass a fake without touching the real
   * keychain.
   *
   * In production this is wired to the resolved KeyStore via
   * `src/keychain.ts`'s `keychainGet`-style reads through the
   * Store's `resolve(tool, label)` method.
   */
  resolveCredential: (tool: string, label: string) => string | null;
  /** Injectable fetch — tests pass a stub. */
  fetch?: typeof fetch;
}

const SERVER_NAME = "subscribetome";
// Bump if the tool schema changes in a breaking way. Codex caches
// `tools/list` per server name+version, so this is the load-bearing
// versioning surface.
const SERVER_VERSION = "0.7.0";
// The MCP protocol version we report in `initialize`. Codex
// negotiates with the client's stated version; this is the spec
// version we tested against.
const PROTOCOL_VERSION = "2024-11-05";

/**
 * Handle one parsed JSON-RPC request. Pure, sync-where-possible,
 * promise-based for tool calls (the upstream fetch is async).
 * Returns null for notifications (no `id`) — the wire layer
 * skips writing a reply in that case.
 *
 * Exported so tests can drive method-by-method without going
 * through the stdio framing.
 */
export async function handleRequest(
  req: JsonRpcRequest,
  deps: ServerDeps,
): Promise<JsonRpcResponse | null> {
  const isNotification = req.id == null;
  const id = req.id ?? null;

  const reply = (result: unknown): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    result,
  });
  const fail = (code: number, message: string, data?: unknown): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });

  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return isNotification ? null : fail(ERR_INVALID_REQUEST, "malformed JSON-RPC envelope");
  }

  switch (req.method) {
    case "initialize": {
      // Codex's handshake. We advertise the protocol version,
      // server identity, and the `tools` capability. The reply
      // shape follows the MCP spec — minimal but complete.
      const result = {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
      };
      return isNotification ? null : reply(result);
    }
    case "notifications/initialized":
    case "initialized": {
      // Client telling us "I've finished initializing". No reply.
      return null;
    }
    case "ping": {
      return isNotification ? null : reply({});
    }
    case "tools/list": {
      return isNotification ? null : reply({ tools: [toolSchema()] });
    }
    case "tools/call": {
      const params = (req.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (params.name !== "stm_http_request") {
        return fail(
          ERR_METHOD_NOT_FOUND,
          `unknown tool: ${params.name ?? "(missing)"} ` +
            `(known: stm_http_request)`,
        );
      }
      try {
        const out = await callTool(params.arguments ?? {}, deps);
        return reply(out);
      } catch (e: any) {
        // We never include the credential value in the error. The
        // worst case here is a generic message from `fetch` /
        // typeerror.
        return fail(
          ERR_INTERNAL,
          `tool execution failed: ${e?.message ?? String(e)}`,
        );
      }
    }
    default:
      return isNotification
        ? null
        : fail(ERR_METHOD_NOT_FOUND, `method not found: ${req.method}`);
  }
}

/**
 * Carry out one `stm_http_request` tool call. Returns the MCP
 * content array shape Codex expects on `tools/call`:
 *   { content: [{ type: "text", text: "..." }], isError?: true }
 *
 * The credential value is read fresh from the KeyStore (so a
 * rotated key takes effect on the next call without a server
 * restart) and used to populate ONE header. It is never reflected
 * back to the client.
 */
async function callTool(
  args: Record<string, unknown>,
  deps: ServerDeps,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const providerId = String(args.provider ?? "");
  const def = findProvider(providerId);
  if (!def) {
    return {
      content: [
        {
          type: "text",
          text:
            `unknown provider "${providerId}". known: ` +
            listProviderIds().join(", "),
        },
      ],
      isError: true,
    };
  }

  const credValue = deps.resolveCredential(def.credential.tool, def.credential.label);
  if (!credValue) {
    return {
      content: [
        {
          type: "text",
          text:
            `no stm credential available for ${def.id} ` +
            `(expected stm placeholder: {{stm:${def.credential.tool}:${def.credential.label}}}). ` +
            `Add it via the dashboard, then retry.`,
        },
      ],
      isError: true,
    };
  }

  const method = String(args.method ?? "GET").toUpperCase();
  const rawPath = typeof args.path === "string" ? args.path : "";
  if (!rawPath || !rawPath.startsWith("/")) {
    return {
      content: [
        {
          type: "text",
          text: `path is required and must start with '/'. Got: ${JSON.stringify(args.path)}`,
        },
      ],
      isError: true,
    };
  }

  const url = buildURL(def, rawPath, args.query);

  // ---- headers ----
  // Merge order: provider defaults → agent headers → server-injected
  // auth header. Agent headers OVERRIDE provider defaults (a
  // deliberate one-off override). The auth header is LAST so the
  // agent can never overwrite it.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(def.defaultHeaders ?? {})) headers[k] = v;
  if (typeof args.headers === "object" && args.headers !== null) {
    for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v;
    }
  }
  // Strip any auth-shaped header the agent tried to set. Defense in
  // depth — the schema description says NOT to set it, but a
  // misbehaving agent shouldn't be able to override our auth.
  delete headers["Authorization"];
  delete headers["authorization"];
  delete headers["x-api-key"];
  delete headers["X-API-Key"];
  const authHeader = buildAuthHeader(def, credValue);
  headers[authHeader.name] = authHeader.value;

  // ---- body ----
  let body: BodyInit | undefined;
  if (args.body !== undefined && method !== "GET" && method !== "DELETE") {
    if (typeof args.body === "string") {
      body = args.body;
    } else {
      // The provider expects JSON when its default Content-Type is
      // application/json; we JSON-stringify in that case. For
      // form-encoded providers the agent should pass a string.
      const isJson = (headers["Content-Type"] ?? "")
        .toLowerCase()
        .includes("application/json");
      body = isJson ? JSON.stringify(args.body) : String(args.body);
    }
  }

  const f = deps.fetch ?? fetch;
  const resp = await f(url, { method, headers, body });
  const respText = await resp.text();

  // The response body MIGHT contain a credential (e.g. if the
  // upstream echoed a header back). We don't try to redact —
  // detection is unreliable — but we DO clip absurdly large
  // bodies to keep the JSON-RPC frame manageable. Codex chunks at
  // ~1MB by default; we stop at 256KB which is plenty for any
  // real API response and well under the chunk boundary.
  const MAX = 256 * 1024;
  const clipped = respText.length > MAX
    ? respText.slice(0, MAX) + `\n…(truncated; ${respText.length - MAX} bytes elided)…\n`
    : respText;

  // Shape the response so the agent has structured access to
  // status + headers + body without needing to parse a custom
  // format. JSON inside the `text` content is the simplest
  // structure-preserving choice for MCP's text-content shape.
  const payload = {
    status: resp.status,
    headers: Object.fromEntries(resp.headers.entries()),
    body: clipped,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: resp.status >= 400,
  };
}

function buildURL(
  def: McpProviderDef,
  path: string,
  query: unknown,
): string {
  const u = new URL(path, def.baseURL);
  if (query && typeof query === "object" && !Array.isArray(query)) {
    for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

// ---- stdio framing ----
//
// MCP over stdio sends one JSON-RPC message per line (newline-
// delimited JSON). Codex's local transport uses this shape. We
// keep the implementation simple: read lines from stdin, dispatch,
// write the reply followed by a newline.

export async function runStdioServer(deps: ServerDeps): Promise<void> {
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk);
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      await dispatchLine(line, deps);
    }
  }
  // Handle a trailing line without newline (graceful end-of-stream).
  if (buf.trim()) {
    await dispatchLine(buf, deps);
  }
}

async function dispatchLine(line: string, deps: ServerDeps): Promise<void> {
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line) as JsonRpcRequest;
  } catch (e: any) {
    // Per JSON-RPC: on parse error reply with id: null. But if the
    // sender produced un-parseable JSON we can't know their id, so
    // null it is.
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: ERR_PARSE,
          message: `parse error: ${e?.message ?? String(e)}`,
        },
      } satisfies JsonRpcResponse) + "\n",
    );
    return;
  }
  const reply = await handleRequest(req, deps);
  if (reply) {
    process.stdout.write(JSON.stringify(reply) + "\n");
  }
}
