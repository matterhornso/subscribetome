// The credential broker — the platform spine.
//
// Today STM substitutes a real key INTO a shell command at runtime. That works
// everywhere but has a ceiling: for the moment the command runs, the key is a
// real argv element, visible to `ps` and to any command that prints its own
// arguments. The broker removes that ceiling for the common case (HTTP APIs).
//
// Instead of putting the key in the command, the agent points its request at
// the local broker:
//
//     curl http://127.0.0.1:<port>/proxy/openai/default/v1/chat/completions ...
//
// The broker looks up the (tool,label) credential in the OS keychain, attaches
// the real auth on the OUTBOUND request to the provider, and streams the
// response back. The key never enters the command's argv, environment, or
// output. The command carries only STM's local, per-run capability token —
// which is loopback-only and worthless to anyone off this machine.
//
// This module is PURE and dependency-injected (a `resolveKey` callback and an
// optional `fetch`), so it is fully testable without a keychain, a daemon, or a
// network. The daemon (src/daemon.ts) is a thin adapter over `brokerRequest`.
//
// SECURITY INVARIANTS enforced here:
//   1. The resolved key is attached ONLY to the outbound request to the
//      target's own origin. An SSRF guard rejects any path that would resolve
//      to a different host, so a crafted path can never redirect the key
//      elsewhere.
//   2. The key value is scrubbed out of the response (body + headers) before it
//      is returned, so an upstream that echoes the credential back cannot leak
//      it into the caller's output.
//   3. Any client-supplied auth for the injected scheme is dropped before the
//      real auth is attached, so the caller can neither override nor read it.
//   4. This module NEVER logs a resolved key value.
import { detectKeys } from "./detect.ts";

/** How a target expects its credential to be presented. */
export type AuthInjection =
  | { kind: "bearer" } // Authorization: Bearer <key>
  | { kind: "header"; name: string; prefix?: string } // <name>: <prefix?><key>
  | { kind: "query"; name: string }; // append ?<name>=<key>

export interface BrokerTarget {
  /** Tool id — matches the placeholder grammar tool and the catalog id. */
  id: string;
  /** Origin the broker forwards to, e.g. "https://api.openai.com". No path. */
  baseUrl: string;
  /** How the credential is attached to the outbound request. */
  auth: AuthInjection;
}

/**
 * Built-in broker targets. Data-only — adding a provider is one entry. The
 * base URLs and auth schemes are the providers' public, documented ones.
 * Intentionally small to start; the registry is extensible and a future
 * milestone lets users register custom targets.
 */
export const BROKER_TARGETS: Record<string, BrokerTarget> = {
  openai: { id: "openai", baseUrl: "https://api.openai.com", auth: { kind: "bearer" } },
  anthropic: {
    id: "anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: { kind: "header", name: "x-api-key" },
  },
  openrouter: {
    id: "openrouter",
    baseUrl: "https://openrouter.ai",
    auth: { kind: "bearer" },
  },
  groq: { id: "groq", baseUrl: "https://api.groq.com", auth: { kind: "bearer" } },
  replicate: {
    id: "replicate",
    baseUrl: "https://api.replicate.com",
    auth: { kind: "header", name: "Authorization", prefix: "Token " },
  },
  fal: {
    id: "fal",
    baseUrl: "https://fal.run",
    auth: { kind: "header", name: "Authorization", prefix: "Key " },
  },
  stripe: { id: "stripe", baseUrl: "https://api.stripe.com", auth: { kind: "bearer" } },
};

export function getBrokerTarget(
  tool: string,
  targets: Record<string, BrokerTarget> = BROKER_TARGETS,
): BrokerTarget | null {
  return targets[tool] ?? null;
}

export interface BrokerRequest {
  tool: string;
  label: string;
  /** Upstream path, MUST start with "/". May include a query string. */
  path: string;
  method: string;
  /** Caller's headers (a plain object). Auth for the injected scheme is dropped. */
  headers: Record<string, string>;
  /** Raw request body, or null for bodyless methods. */
  body?: Uint8Array | string | null;
}

export interface BrokerResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  /** Response body as text, with any occurrence of the real key scrubbed. */
  body: string;
  /** Set on a broker-side rejection (target/credential/path problem). */
  error?: string;
}

export interface BrokerDeps {
  /** Resolve a (tool,label) to its secret, or null if unknown/revoked. */
  resolveKey: (tool: string, label: string) => string | null;
  fetch?: typeof fetch;
  targets?: Record<string, BrokerTarget>;
  signal?: AbortSignal;
}

/** Header names that carry auth for a given scheme — dropped from the caller's
 *  request before we attach the real one, so the caller can't override it. */
function authHeaderNames(auth: AuthInjection): string[] {
  if (auth.kind === "bearer") return ["authorization"];
  if (auth.kind === "header") return [auth.name.toLowerCase()];
  return [];
}

/** Upstream response body cap (16 MiB) — a hostile/compromised provider must
 *  not be able to OOM the daemon by returning an unbounded body. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Hop-by-hop + connection headers that must not be forwarded to the upstream
 *  (RFC 7230 §6.1 plus proxy-auth). */
const HOP_BY_HOP = [
  "host", "content-length", "connection", "keep-alive", "transfer-encoding",
  "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate",
];

/** Replace every occurrence of `secret` in `text` with a fixed marker. Literal
 *  (non-regex) global replace, so a secret with regex metachars is handled.
 *  Also strips the percent-ENCODED form, since a query-auth target's key appears
 *  URL-encoded in a request URL that an error message may embed. */
function scrub(text: string, secret: string): string {
  if (!secret) return text;
  let out = text.split(secret).join("[stm:redacted]");
  const enc = encodeURIComponent(secret);
  if (enc !== secret) out = out.split(enc).join("[stm:redacted]");
  // Defense in depth: also mask any OTHER key-shaped token the upstream echoed.
  for (const hit of detectKeys(out)) out = out.split(hit.value).join("[stm:redacted]");
  return out;
}

/** Read a response body as text, but abort past `max` bytes so a hostile
 *  upstream can't OOM the daemon. Returns null if the cap is exceeded. */
export async function readBodyCapped(resp: Response, max: number): Promise<string | null> {
  const reader = resp.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > max) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Broker one request: resolve the credential, attach it to the outbound call to
 * the target's own origin, and return the scrubbed response. The key is never
 * placed in the returned result except as a redaction marker.
 */
export async function brokerRequest(
  req: BrokerRequest,
  deps: BrokerDeps,
): Promise<BrokerResult> {
  const doFetch = deps.fetch ?? fetch;
  const target = getBrokerTarget(req.tool, deps.targets);
  if (!target) {
    return { ok: false, status: 404, headers: {}, body: "", error: `no broker target for tool "${req.tool}"` };
  }

  // Path must be server-relative. Reject anything that could point off-origin
  // (protocol-relative "//host", an absolute URL, or a "\" that some parsers
  // treat as "/"). We then re-verify the resolved origin below as a backstop.
  if (typeof req.path !== "string" || !req.path.startsWith("/") || req.path.startsWith("//") || req.path.includes("\\")) {
    return { ok: false, status: 400, headers: {}, body: "", error: "path must be a server-relative path beginning with a single '/'" };
  }

  let url: URL;
  let baseOrigin: string;
  try {
    baseOrigin = new URL(target.baseUrl).origin;
    url = new URL(baseOrigin + req.path);
  } catch {
    return { ok: false, status: 400, headers: {}, body: "", error: "could not construct upstream URL" };
  }
  // SSRF backstop: the constructed URL's origin MUST equal the target's origin.
  if (url.origin !== baseOrigin) {
    return { ok: false, status: 400, headers: {}, body: "", error: "path resolved to a different origin — refused" };
  }

  const key = deps.resolveKey(req.tool, req.label);
  if (key == null) {
    return { ok: false, status: 401, headers: {}, body: "", error: `no credential for ${req.tool}:${req.label} — add it in the dashboard` };
  }

  // Copy caller headers, dropping any auth for the scheme we're about to inject
  // and hop-by-hop headers that must not be forwarded.
  const drop = new Set([...authHeaderNames(target.auth), ...HOP_BY_HOP]);
  const outHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (!drop.has(k.toLowerCase())) outHeaders[k] = v;
  }

  // Attach the real credential on the outbound request only.
  if (target.auth.kind === "bearer") {
    outHeaders["Authorization"] = `Bearer ${key}`;
  } else if (target.auth.kind === "header") {
    outHeaders[target.auth.name] = `${target.auth.prefix ?? ""}${key}`;
  } else {
    url.searchParams.set(target.auth.name, key);
  }

  let resp: Response;
  try {
    resp = await doFetch(url.toString(), {
      method: req.method,
      headers: outHeaders,
      body: req.body ?? undefined,
      signal: deps.signal,
      // CRITICAL: do NOT auto-follow redirects. The injected credential is on
      // this request's headers; if the provider 3xx-redirects off-origin, a
      // followed request would replay a custom auth header (e.g. x-api-key) to
      // another host — a key leak the SSRF path-guard can't see. Surface the
      // 3xx to the caller instead of following it with the key attached.
      redirect: "manual",
    });
  } catch (e: any) {
    // Scrub the key from any network-error message too (fetch/undici can embed
    // the request URL, which for a query-auth target contains the key).
    return { ok: false, status: 502, headers: {}, body: "", error: scrub(e?.message ?? String(e), key) };
  }

  const rawBody = await readBodyCapped(resp, MAX_RESPONSE_BYTES);
  if (rawBody === null) {
    return { ok: false, status: 502, headers: {}, body: "", error: "upstream response exceeded the broker size limit" };
  }
  const body = scrub(rawBody, key);
  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    headers[k] = scrub(v, key);
  });

  return { ok: resp.ok, status: resp.status, headers, body };
}
