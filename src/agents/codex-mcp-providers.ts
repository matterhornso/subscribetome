// Codex MCP-wrapped provider registry — v0.7.0.
//
// Build plan source: specs/cross-platform-and-codex.md §6 (Option 2).
//
// What this is:
//   The MCP server (`src/agents/codex-mcp.ts`) exposes a generic
//   `stm_http_request` tool. The tool's arguments include a
//   `provider` name. The server looks the provider up here and
//   knows:
//     - The base URL (so the agent never types a domain).
//     - The auth-header scheme (Bearer / x-api-key / Basic / etc.).
//     - The credential's (tool, label) pair in the KeyStore — that
//       is, which entry from `stm list` carries the actual key.
//     - Any provider-specific required headers (e.g. Anthropic's
//       `anthropic-version`).
//
//   At MCP-server startup, the server resolves each provider's
//   credential through the existing KeyStore (so the secret never
//   leaves the OS keychain → the server process → the upstream
//   provider; it never touches the agent's process, never lands
//   in argv, never appears in the chat).
//
// Why a separate registry instead of using `src/catalog.ts`:
//   The catalog answers "which services does the dashboard let me
//   wire up?". This registry answers "for which services does stm
//   know enough to broker an HTTPS request on the user's behalf?".
//   The two will overlap heavily but not identically — e.g. AWS is
//   in the catalog (key inventory) but is too SDK-shaped to be a
//   useful generic-HTTP wrapper. Keeping them separate avoids
//   pretending one is the other.
//
// Scope for v0.7.0 (curated launch set):
//   - openai          : Bearer + Content-Type: application/json
//   - anthropic       : x-api-key + anthropic-version + Content-Type
//   - stripe          : Basic <key>: (key is the username, empty password)
//   - github          : Bearer + Accept: application/vnd.github+json
//   - resend          : Bearer + Content-Type: application/json
//
//   The pattern generalizes — adding a provider is one entry below
//   plus a CHANGELOG line. We do NOT enumerate the full 50-service
//   catalog up front because each provider needs a tested auth
//   shape, and shipping unverified entries is worse than honest
//   coverage of five.

export interface McpProviderDef {
  /** Stable id used by the agent. Matches the stm tool id. */
  id: string;
  /** Human label shown in tools/list descriptions. */
  name: string;
  /** Base URL — every relative path the agent provides resolves
   *  against this, so the agent never types a domain. */
  baseURL: string;
  /**
   * The (tool, label) pair in the stm KeyStore that supplies the
   * upstream credential. Defaults to `{tool: id, label: "default"}`
   * — the convention every other v1.x feature uses.
   */
  credential: { tool: string; label: string };
  /**
   * How to attach the credential to outbound HTTP requests. The
   * shapes are kept small + explicit because each upstream gets
   * the auth wrong in a different way:
   *   - `bearer`        — `Authorization: Bearer <value>`
   *   - `x-api-key`     — `x-api-key: <value>`
   *   - `basic-user`    — `Authorization: Basic base64(value + ":")`
   *                       (Stripe-style; key is the username, empty pass)
   */
  auth: "bearer" | "x-api-key" | "basic-user";
  /**
   * Static request headers attached to every outbound request,
   * e.g. Anthropic's `anthropic-version`. Merged with the agent's
   * headers; agent headers WIN on conflict (so a one-off override
   * is possible).
   */
  defaultHeaders?: Record<string, string>;
  /**
   * A short one-line description shown in `tools/list`. Helps the
   * agent disambiguate when multiple providers are eligible.
   */
  description: string;
}

export const MCP_PROVIDERS: McpProviderDef[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseURL: "https://api.openai.com",
    credential: { tool: "openai", label: "default" },
    auth: "bearer",
    defaultHeaders: { "Content-Type": "application/json" },
    description: "OpenAI API (chat, completions, embeddings, images, audio)",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseURL: "https://api.anthropic.com",
    credential: { tool: "anthropic", label: "default" },
    auth: "x-api-key",
    defaultHeaders: {
      "Content-Type": "application/json",
      // Anthropic requires this on every call — the docs are clear
      // that omitting it is a 400. Versioned because the wire shape
      // CAN change; stm pins a stable known-good version.
      "anthropic-version": "2023-06-01",
    },
    description: "Anthropic Messages API (Claude models)",
  },
  {
    id: "stripe",
    name: "Stripe",
    baseURL: "https://api.stripe.com",
    credential: { tool: "stripe", label: "default" },
    auth: "basic-user",
    defaultHeaders: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    description: "Stripe REST API (charges, customers, payment intents)",
  },
  {
    id: "github",
    name: "GitHub",
    baseURL: "https://api.github.com",
    credential: { tool: "github", label: "default" },
    auth: "bearer",
    defaultHeaders: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    description: "GitHub REST API (repos, issues, PRs, actions)",
  },
  {
    id: "resend",
    name: "Resend",
    baseURL: "https://api.resend.com",
    credential: { tool: "resend", label: "default" },
    auth: "bearer",
    defaultHeaders: { "Content-Type": "application/json" },
    description: "Resend transactional email API",
  },
];

export function findProvider(id: string): McpProviderDef | null {
  return MCP_PROVIDERS.find((p) => p.id === id) ?? null;
}

export function listProviderIds(): string[] {
  return MCP_PROVIDERS.map((p) => p.id);
}

/**
 * Build the `Authorization` (or equivalent) header value for a
 * given provider + credential value. Pure — no I/O. Centralized so
 * a future addition is one switch arm here, not a scattered
 * "where does the auth header come from" question across the
 * server code.
 *
 * The server NEVER logs the return value of this function.
 */
export function buildAuthHeader(
  def: McpProviderDef,
  credentialValue: string,
): { name: string; value: string } {
  switch (def.auth) {
    case "bearer":
      return { name: "Authorization", value: `Bearer ${credentialValue}` };
    case "x-api-key":
      return { name: "x-api-key", value: credentialValue };
    case "basic-user": {
      // Stripe convention: key as username, empty password. The
      // `${value}:` shape is part of HTTP Basic, not stm-specific.
      const b64 = Buffer.from(`${credentialValue}:`).toString("base64");
      return { name: "Authorization", value: `Basic ${b64}` };
    }
  }
}

/**
 * MCP tool schema for `stm_http_request`. Exposed so the server can
 * emit it verbatim in `tools/list` AND tests can assert the shape
 * without parsing JSON-RPC text.
 *
 * The schema is intentionally small: an agent calling this tool
 * needs to say only WHICH provider + WHAT path + (optionally) the
 * method, body, headers, and query params. Everything auth-shaped
 * is server-side.
 */
export function toolSchema(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  const providerList = MCP_PROVIDERS.map((p) => `${p.id} — ${p.description}`).join(
    "; ",
  );
  return {
    name: "stm_http_request",
    description:
      "Make an HTTPS request to a configured provider using stm's locally-stored " +
      "credential — the auth header is injected by the MCP server, so the agent " +
      "never sees or handles the API key. " +
      `Known providers: ${providerList}.`,
    inputSchema: {
      type: "object",
      required: ["provider", "path"],
      properties: {
        provider: {
          type: "string",
          description:
            "Which provider to call. Must be one of the registered ids: " +
            listProviderIds().join(", ") +
            ".",
          enum: listProviderIds(),
        },
        method: {
          type: "string",
          description:
            "HTTP method. Defaults to GET. POST/PUT/PATCH/DELETE supported.",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          default: "GET",
        },
        path: {
          type: "string",
          description:
            "URL path, including any leading slash, resolved against the " +
            "provider's base URL. Examples: '/v1/chat/completions' (OpenAI), " +
            "'/v1/messages' (Anthropic).",
        },
        query: {
          type: "object",
          description:
            "Optional query-string parameters. Each value is URL-encoded.",
          additionalProperties: { type: "string" },
        },
        headers: {
          type: "object",
          description:
            "Optional request headers. Provider defaults (Content-Type, " +
            "Accept, version pins) are merged in; agent headers WIN on " +
            "conflict. The Authorization / x-api-key header MUST NOT be " +
            "provided by the agent — the server injects it.",
          additionalProperties: { type: "string" },
        },
        body: {
          description:
            "Optional request body. Pass a JSON object for JSON providers " +
            "(it is JSON.stringify-ed); pass a string for form-encoded " +
            "providers (it is sent verbatim).",
        },
      },
    },
  };
}
