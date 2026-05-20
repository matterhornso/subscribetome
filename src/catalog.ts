// A catalog of common services and the credential set each one needs.
//
// This drives the dashboard's "Add keys" picker: choose a service and the form
// presents the right pre-labelled value fields (Supabase → service-role-key,
// anon-key, db-password; Twilio → account-sid, auth-token; etc.). It is only a
// set of suggested labels — every label still obeys the placeholder grammar,
// and the user can always pick "Other" for a free-form tool + label.
//
// Adding a service here is a data-only change: append an entry and the
// dashboard picks it up. `id` is the tool name (placeholder grammar:
// lowercase a-z, 0-9, hyphen); `credentials` are suggested labels. The set was
// compiled from the credential names each service uses in its own docs.

export interface ServiceDef {
  /** Tool name — becomes the `<tool>` in {{stm:<tool>:<label>}}. */
  id: string;
  /** Human-readable name shown in the picker. */
  name: string;
  /** Suggested credential labels for this service. */
  credentials: string[];
}

export const CATALOG: ServiceDef[] = [
  // ---- AI / LLM providers ----
  { id: "openai", name: "OpenAI", credentials: ["api-key"] },
  { id: "anthropic", name: "Anthropic", credentials: ["api-key"] },
  { id: "google-gemini", name: "Google Gemini", credentials: ["api-key"] },
  { id: "groq", name: "Groq", credentials: ["api-key"] },
  { id: "mistral", name: "Mistral AI", credentials: ["api-key"] },
  { id: "openrouter", name: "OpenRouter", credentials: ["api-key"] },
  { id: "fal", name: "fal.ai", credentials: ["api-key"] },
  { id: "replicate", name: "Replicate", credentials: ["api-token"] },
  { id: "elevenlabs", name: "ElevenLabs", credentials: ["api-key"] },

  // ---- Databases / backends ----
  {
    id: "supabase",
    name: "Supabase",
    credentials: ["service-role-key", "anon-key", "db-password"],
  },
  { id: "neon", name: "Neon", credentials: ["database-url"] },
  {
    id: "mongodb-atlas",
    name: "MongoDB Atlas",
    credentials: ["connection-string"],
  },
  {
    id: "upstash-redis",
    name: "Upstash Redis",
    credentials: ["rest-url", "rest-token"],
  },
  {
    id: "firebase",
    name: "Firebase",
    credentials: [
      "api-key",
      "auth-domain",
      "project-id",
      "storage-bucket",
      "messaging-sender-id",
      "app-id",
    ],
  },

  // ---- Deployment / hosting ----
  { id: "vercel", name: "Vercel", credentials: ["access-token"] },
  { id: "netlify", name: "Netlify", credentials: ["auth-token"] },
  { id: "railway", name: "Railway", credentials: ["token"] },
  {
    id: "cloudflare",
    name: "Cloudflare",
    credentials: ["api-token", "account-id"],
  },
  {
    id: "aws",
    name: "AWS",
    credentials: ["access-key-id", "secret-access-key", "region"],
  },

  // ---- Auth ----
  { id: "clerk", name: "Clerk", credentials: ["publishable-key", "secret-key"] },
  {
    id: "auth0",
    name: "Auth0",
    credentials: ["domain", "client-id", "client-secret"],
  },

  // ---- Payments ----
  {
    id: "stripe",
    name: "Stripe",
    credentials: ["secret-key", "publishable-key", "webhook-secret"],
  },

  // ---- Email / SMS / messaging ----
  { id: "resend", name: "Resend", credentials: ["api-key"] },
  { id: "sendgrid", name: "SendGrid", credentials: ["api-key"] },
  {
    id: "twilio",
    name: "Twilio",
    credentials: ["account-sid", "auth-token"],
  },
  {
    id: "slack",
    name: "Slack",
    credentials: ["bot-token", "signing-secret"],
  },
  { id: "telegram", name: "Telegram", credentials: ["bot-token"] },
  { id: "discord", name: "Discord", credentials: ["bot-token"] },

  // ---- Social ----
  {
    id: "twitter",
    name: "Twitter / X",
    credentials: [
      "api-key",
      "api-secret",
      "access-token",
      "access-token-secret",
      "bearer-token",
    ],
  },

  // ---- Search & web-scraping (AI agents) ----
  { id: "tavily", name: "Tavily", credentials: ["api-key"] },
  { id: "firecrawl", name: "Firecrawl", credentials: ["api-key"] },
  { id: "exa", name: "Exa", credentials: ["api-key"] },
  { id: "parallel-web-systems", name: "Parallel Web Systems", credentials: ["api-key"] },

  // ---- Monitoring / analytics ----
  { id: "sentry", name: "Sentry", credentials: ["dsn", "auth-token"] },
  { id: "posthog", name: "PostHog", credentials: ["project-api-key"] },

  // ---- Version control ----
  { id: "github", name: "GitHub", credentials: ["token"] },
];
