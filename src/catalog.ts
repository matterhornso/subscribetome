// A catalog of common services and the credential set each one needs.
//
// This drives the dashboard's "Add keys" picker: choose a service and the form
// presents the right pre-labelled value fields (Supabase → service-role-key,
// anon-key, db-password; Twilio → account-sid, auth-token; etc.). It is only a
// set of suggested labels — every label still obeys the placeholder grammar,
// and the user can always pick "Other" for a free-form tool + label.
//
// As of v0.2.6 the catalog also drives a "Browse services" section on the
// dashboard (see specs/service-catalog-browser.md). Each entry carries a
// `category` (one of the ServiceCategory constants below) and a `url`
// pointing at the provider's API-keys page so a click opens that page in a
// new tab.
//
// Adding a service here is still a data-only change: append an entry with
// `id`, `name`, `credentials`, `category`, and `url` and the dashboard picks
// it up. `id` is the tool name (placeholder grammar: lowercase a-z, 0-9,
// hyphen); `credentials` are suggested labels.

/**
 * The taxonomy that ships with the catalog browser. See
 * specs/service-catalog-browser.md §4 for the rationale.
 */
export type ServiceCategory =
  | "ai"
  | "database"
  | "hosting"
  | "auth"
  | "payments"
  | "email"
  | "comms"
  | "social"
  | "sales"
  | "search"
  | "monitoring"
  | "vcs";

/** Display label for a category in the dashboard "Browse services" card. */
export const CATEGORY_LABEL: Record<ServiceCategory, string> = {
  ai: "AI & LLM",
  database: "Database & backend",
  hosting: "Hosting & deploy",
  auth: "Auth",
  payments: "Payments",
  email: "Email",
  comms: "Comms & messaging",
  social: "Social media",
  sales: "Sales & outreach",
  search: "Search & web",
  monitoring: "Monitoring & analytics",
  vcs: "Dev tools",
};

/** Render order for the categories in the browser card. */
export const CATEGORY_ORDER: ServiceCategory[] = [
  "ai",
  "database",
  "hosting",
  "auth",
  "payments",
  "email",
  "comms",
  "social",
  "sales",
  "search",
  "monitoring",
  "vcs",
];

export interface ServiceDef {
  /** Tool name — becomes the `<tool>` in {{stm:<tool>:<label>}}. */
  id: string;
  /** Human-readable name shown in the picker. */
  name: string;
  /** Suggested credential labels for this service. */
  credentials: string[];
  /** Where this service belongs in the browse-services taxonomy. */
  category: ServiceCategory;
  /**
   * URL the "Browse services" card opens in a new tab. Prefer the
   * provider's API-keys settings page when stable; fall back to the
   * dashboard or signup root if the keys page 404s on a direct unauthed
   * hit. HEAD-checked at build time.
   */
  url: string;
  /** Optional one-line description (≤60 chars). Surfaced via `title` attr. */
  tagline?: string;
  /**
   * Spend-visibility (v0.3.0, specs/spend-visibility.md): true when this
   * provider exposes a usage / billing API stm can sync against. The
   * dashboard shows an "Enable sync" toggle on these entries; clicking
   * it prompts for the separate usage credential.
   */
  supportsUsage?: boolean;
  /**
   * Credential label the sync orchestrator looks up against this tool
   * to obtain a usage key (e.g. `admin-key`). Always different from
   * the runtime credential since usage APIs are admin-scoped.
   */
  usageCredentialLabel?: string;
}

export const CATALOG: ServiceDef[] = [
  // ---- AI / LLM providers ----
  {
    id: "openai",
    name: "OpenAI",
    credentials: ["api-key", "admin-key"],
    category: "ai",
    url: "https://platform.openai.com/api-keys",
    supportsUsage: true,
    usageCredentialLabel: "admin-key",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    credentials: ["api-key", "admin-key"],
    category: "ai",
    url: "https://console.anthropic.com/settings/keys",
    supportsUsage: true,
    usageCredentialLabel: "admin-key",
  },
  {
    id: "google-gemini",
    name: "Google Gemini",
    credentials: ["api-key"],
    category: "ai",
    url: "https://aistudio.google.com/app/apikey",
  },
  {
    id: "groq",
    name: "Groq",
    credentials: ["api-key"],
    category: "ai",
    url: "https://console.groq.com/keys",
  },
  {
    id: "mistral",
    name: "Mistral AI",
    credentials: ["api-key"],
    category: "ai",
    url: "https://console.mistral.ai/api-keys",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    credentials: ["api-key"],
    category: "ai",
    url: "https://openrouter.ai/keys",
  },
  {
    id: "fal",
    name: "fal.ai",
    credentials: ["api-key"],
    category: "ai",
    url: "https://fal.ai/dashboard/keys",
  },
  {
    id: "replicate",
    name: "Replicate",
    credentials: ["api-token"],
    category: "ai",
    url: "https://replicate.com/account/api-tokens",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    credentials: ["api-key"],
    category: "ai",
    url: "https://elevenlabs.io/app/settings/api-keys",
  },
  {
    id: "cohere",
    name: "Cohere",
    credentials: ["api-key"],
    category: "ai",
    url: "https://dashboard.cohere.com/api-keys",
  },
  {
    id: "together",
    name: "Together AI",
    credentials: ["api-key"],
    category: "ai",
    url: "https://api.together.xyz/settings/api-keys",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    credentials: ["api-key"],
    category: "ai",
    url: "https://www.perplexity.ai/settings/api",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    credentials: ["api-key"],
    category: "ai",
    url: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    credentials: ["api-key"],
    category: "ai",
    url: "https://console.x.ai/",
  },
  {
    id: "deepgram",
    name: "Deepgram",
    credentials: ["api-key"],
    category: "ai",
    url: "https://console.deepgram.com/",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    credentials: ["access-token"],
    category: "ai",
    url: "https://huggingface.co/settings/tokens",
  },
  {
    id: "stability",
    name: "Stability AI",
    credentials: ["api-key"],
    category: "ai",
    url: "https://platform.stability.ai/account/keys",
  },
  {
    id: "assemblyai",
    name: "AssemblyAI",
    credentials: ["api-key"],
    category: "ai",
    url: "https://www.assemblyai.com/app",
  },
  {
    id: "voyage",
    name: "Voyage AI",
    credentials: ["api-key"],
    category: "ai",
    url: "https://dashboard.voyageai.com/",
  },

  // ---- Databases / backends ----
  {
    id: "supabase",
    name: "Supabase",
    credentials: ["service-role-key", "anon-key", "db-password"],
    category: "database",
    url: "https://supabase.com/dashboard/account/tokens",
  },
  {
    id: "neon",
    name: "Neon",
    credentials: ["database-url"],
    category: "database",
    // /app/settings/api-keys 404s unauthed; /app/projects bounces through
    // login and lands the user where they can grab a database URL.
    url: "https://console.neon.tech/app/projects",
  },
  {
    id: "mongodb-atlas",
    name: "MongoDB Atlas",
    credentials: ["connection-string"],
    category: "database",
    url: "https://cloud.mongodb.com/v2#/account/keyMgmt/apiKeys",
  },
  {
    id: "upstash-redis",
    name: "Upstash Redis",
    credentials: ["rest-url", "rest-token"],
    category: "database",
    url: "https://console.upstash.com/account/api",
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
    category: "database",
    url: "https://console.firebase.google.com/u/0/",
  },
  {
    id: "planetscale",
    name: "PlanetScale",
    credentials: ["service-token-id", "service-token"],
    category: "database",
    url: "https://app.planetscale.com/settings/service-tokens",
  },
  {
    id: "turso",
    name: "Turso",
    credentials: ["database-url", "auth-token"],
    category: "database",
    url: "https://app.turso.tech/",
  },
  {
    id: "convex",
    name: "Convex",
    credentials: ["deploy-key"],
    category: "database",
    url: "https://dashboard.convex.dev/",
  },
  {
    id: "xata",
    name: "Xata",
    credentials: ["api-key"],
    category: "database",
    url: "https://app.xata.io/settings",
  },

  // ---- Deployment / hosting ----
  {
    id: "vercel",
    name: "Vercel",
    credentials: ["access-token"],
    category: "hosting",
    url: "https://vercel.com/account/tokens",
  },
  {
    id: "netlify",
    name: "Netlify",
    credentials: ["auth-token"],
    category: "hosting",
    url: "https://app.netlify.com/user/applications#personal-access-tokens",
  },
  {
    id: "railway",
    name: "Railway",
    credentials: ["token"],
    category: "hosting",
    url: "https://railway.com/account/tokens",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    credentials: ["api-token", "account-id"],
    category: "hosting",
    url: "https://dash.cloudflare.com/profile/api-tokens",
  },
  {
    id: "aws",
    name: "AWS",
    credentials: ["access-key-id", "secret-access-key", "region"],
    category: "hosting",
    url: "https://console.aws.amazon.com/iam/home#/security_credentials",
  },
  {
    id: "fly",
    name: "Fly.io",
    credentials: ["api-token"],
    category: "hosting",
    url: "https://fly.io/user/personal_access_tokens",
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    credentials: ["personal-access-token"],
    category: "hosting",
    url: "https://cloud.digitalocean.com/account/api/tokens",
  },
  {
    id: "render",
    name: "Render",
    credentials: ["api-key"],
    category: "hosting",
    url: "https://dashboard.render.com/u/settings#api-keys",
  },
  {
    id: "linode",
    name: "Akamai (Linode)",
    credentials: ["personal-access-token"],
    category: "hosting",
    url: "https://cloud.linode.com/profile/tokens",
  },

  // ---- Auth ----
  {
    // FIXME: dashboard.clerk.com 404s on every direct deep-link when unauthed
    // (last-active, /apps, root all return 404 from the bot). The marketing
    // site has a Sign In button that bounces the user into their app's API
    // keys page. Revisit if Clerk publishes a stable unauthed entry point.
    id: "clerk",
    name: "Clerk",
    credentials: ["publishable-key", "secret-key"],
    category: "auth",
    url: "https://clerk.com/",
  },
  {
    id: "auth0",
    name: "Auth0",
    credentials: ["domain", "client-id", "client-secret"],
    category: "auth",
    url: "https://manage.auth0.com/dashboard",
  },
  {
    id: "workos",
    name: "WorkOS",
    credentials: ["api-key", "client-id"],
    category: "auth",
    url: "https://dashboard.workos.com/api-keys",
  },
  {
    id: "stytch",
    name: "Stytch",
    credentials: ["project-id", "secret"],
    category: "auth",
    url: "https://stytch.com/dashboard/api-keys",
  },

  // ---- Payments ----
  {
    id: "stripe",
    name: "Stripe",
    credentials: ["secret-key", "publishable-key", "webhook-secret"],
    category: "payments",
    url: "https://dashboard.stripe.com/apikeys",
  },
  {
    id: "lemon-squeezy",
    name: "Lemon Squeezy",
    credentials: ["api-key"],
    category: "payments",
    url: "https://app.lemonsqueezy.com/settings/api",
  },
  {
    id: "paddle",
    name: "Paddle",
    credentials: ["api-key"],
    category: "payments",
    url: "https://vendors.paddle.com/authentication-v2",
  },
  {
    id: "paypal",
    name: "PayPal",
    credentials: ["client-id", "client-secret"],
    category: "payments",
    url: "https://developer.paypal.com/dashboard/applications",
  },
  {
    id: "razorpay",
    name: "Razorpay",
    credentials: ["key-id", "key-secret"],
    category: "payments",
    url: "https://dashboard.razorpay.com/app/keys",
  },
  {
    id: "square",
    name: "Square",
    credentials: ["access-token"],
    category: "payments",
    url: "https://developer.squareup.com/apps",
  },

  // ---- Email ----
  {
    id: "resend",
    name: "Resend",
    credentials: ["api-key"],
    category: "email",
    url: "https://resend.com/api-keys",
  },
  {
    id: "sendgrid",
    name: "SendGrid",
    credentials: ["api-key"],
    category: "email",
    url: "https://app.sendgrid.com/settings/api_keys",
  },
  {
    id: "postmark",
    name: "Postmark",
    credentials: ["server-token"],
    category: "email",
    url: "https://account.postmarkapp.com/servers",
  },
  {
    id: "brevo",
    name: "Brevo",
    credentials: ["api-key"],
    category: "email",
    url: "https://app.brevo.com/settings/keys/api",
  },
  {
    id: "mailgun",
    name: "Mailgun",
    credentials: ["api-key"],
    category: "email",
    url: "https://app.mailgun.com/settings/api_security",
  },
  {
    id: "loops",
    name: "Loops",
    credentials: ["api-key"],
    category: "email",
    url: "https://app.loops.so/settings?page=api",
  },
  {
    id: "mailchimp",
    name: "Mailchimp",
    credentials: ["api-key"],
    category: "email",
    url: "https://admin.mailchimp.com/account/api/",
  },

  // ---- Comms / messaging ----
  {
    id: "twilio",
    name: "Twilio",
    credentials: ["account-sid", "auth-token"],
    category: "comms",
    url: "https://console.twilio.com/us1/account/keys-credentials/api-keys",
  },
  {
    id: "slack",
    name: "Slack",
    credentials: ["bot-token", "signing-secret"],
    category: "comms",
    url: "https://api.slack.com/apps",
  },
  {
    id: "telegram",
    name: "Telegram",
    credentials: ["bot-token"],
    category: "comms",
    url: "https://core.telegram.org/bots#how-do-i-create-a-bot",
  },
  {
    id: "discord",
    name: "Discord",
    credentials: ["bot-token"],
    category: "comms",
    url: "https://discord.com/developers/applications",
  },
  {
    id: "vonage",
    name: "Vonage",
    credentials: ["api-key", "api-secret"],
    category: "comms",
    url: "https://dashboard.nexmo.com/settings",
  },
  {
    id: "pusher",
    name: "Pusher",
    credentials: ["app-id", "key", "secret"],
    category: "comms",
    url: "https://dashboard.pusher.com/",
  },

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
    category: "social",
    url: "https://developer.x.com/en/portal/dashboard",
  },
  {
    id: "typefully",
    name: "Typefully",
    credentials: ["api-key"],
    category: "social",
    url: "https://typefully.com/?settings=integrations",
  },
  {
    id: "postiz",
    name: "Postiz",
    credentials: ["api-key"],
    category: "social",
    url: "https://app.postiz.com/settings",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    credentials: ["client-id", "client-secret"],
    category: "social",
    url: "https://www.linkedin.com/developers/apps",
  },
  {
    id: "buffer",
    name: "Buffer",
    credentials: ["access-token"],
    category: "social",
    url: "https://buffer.com/developers/apps",
  },

  // ---- Sales & outreach ----
  {
    id: "apollo",
    name: "Apollo",
    credentials: ["api-key"],
    category: "sales",
    url: "https://app.apollo.io/#/settings/integrations/api",
  },
  {
    id: "clay",
    name: "Clay",
    credentials: ["api-key"],
    category: "sales",
    url: "https://app.clay.com/workspaces",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    credentials: ["private-app-token"],
    category: "sales",
    url: "https://app.hubspot.com/private-apps",
  },
  {
    id: "hunter",
    name: "Hunter",
    credentials: ["api-key"],
    category: "sales",
    url: "https://hunter.io/api-keys",
  },

  // ---- Search & web ----
  {
    id: "tavily",
    name: "Tavily",
    credentials: ["api-key"],
    category: "search",
    url: "https://app.tavily.com/home",
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    credentials: ["api-key"],
    category: "search",
    url: "https://www.firecrawl.dev/app/api-keys",
  },
  {
    id: "exa",
    name: "Exa",
    credentials: ["api-key"],
    category: "search",
    url: "https://dashboard.exa.ai/api-keys",
  },
  {
    id: "parallel-web-systems",
    name: "Parallel Web Systems",
    credentials: ["api-key"],
    category: "search",
    url: "https://platform.parallel.ai/",
  },
  {
    id: "serpapi",
    name: "SerpApi",
    credentials: ["api-key"],
    category: "search",
    url: "https://serpapi.com/manage-api-key",
  },
  {
    id: "brave-search",
    name: "Brave Search",
    credentials: ["api-key"],
    category: "search",
    url: "https://api-dashboard.search.brave.com/app/keys",
  },

  // ---- Monitoring / analytics ----
  {
    id: "sentry",
    name: "Sentry",
    credentials: ["dsn", "auth-token"],
    category: "monitoring",
    url: "https://sentry.io/settings/account/api/auth-tokens/",
  },
  {
    id: "posthog",
    name: "PostHog",
    credentials: ["project-api-key"],
    category: "monitoring",
    url: "https://app.posthog.com/project/settings",
  },
  {
    id: "datadog",
    name: "Datadog",
    credentials: ["api-key", "app-key"],
    category: "monitoring",
    url: "https://app.datadoghq.com/organization-settings/api-keys",
  },
  {
    id: "axiom",
    name: "Axiom",
    credentials: ["api-token"],
    category: "monitoring",
    url: "https://app.axiom.co/",
  },
  {
    id: "mixpanel",
    name: "Mixpanel",
    credentials: ["project-token"],
    category: "monitoring",
    url: "https://mixpanel.com/settings/project",
  },

  // ---- Dev tools ----
  {
    id: "github",
    name: "GitHub",
    credentials: ["token"],
    category: "vcs",
    url: "https://github.com/settings/tokens",
  },
  {
    id: "linear",
    name: "Linear",
    credentials: ["api-key"],
    category: "vcs",
    url: "https://linear.app/settings/api",
  },
  {
    id: "notion",
    name: "Notion",
    credentials: ["internal-integration-token"],
    category: "vcs",
    url: "https://www.notion.so/profile/integrations",
  },
  {
    id: "gitlab",
    name: "GitLab",
    credentials: ["personal-access-token"],
    category: "vcs",
    url: "https://gitlab.com/-/user_settings/personal_access_tokens",
  },
  {
    id: "airtable",
    name: "Airtable",
    credentials: ["personal-access-token"],
    category: "vcs",
    url: "https://airtable.com/create/tokens",
  },
  {
    id: "jira",
    name: "Jira",
    credentials: ["api-token"],
    category: "vcs",
    url: "https://id.atlassian.com/manage-profile/security/api-tokens",
  },
];
