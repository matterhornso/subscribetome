// A small catalog of known services and the credential set each one needs.
//
// This drives the dashboard's "Add keys" picker: choose a service and the form
// presents the right pre-labelled value fields (Supabase → service-role-key,
// anon-key, db-password; Twitter → its five tokens; etc.). It is only a set of
// suggested labels — every label still obeys the placeholder grammar and the
// user can always pick "Other" for a free-form tool + label.
//
// Adding a service here is a data-only change: append an entry and the
// dashboard picks it up. `id` is the tool name (placeholder grammar:
// lowercase a-z, 0-9, hyphen); `credentials` are suggested labels.

export interface ServiceDef {
  /** Tool name — becomes the `<tool>` in {{stm:<tool>:<label>}}. */
  id: string;
  /** Human-readable name shown in the picker. */
  name: string;
  /** Suggested credential labels for this service. */
  credentials: string[];
}

export const CATALOG: ServiceDef[] = [
  { id: "openai", name: "OpenAI", credentials: ["api-key"] },
  { id: "anthropic", name: "Anthropic", credentials: ["api-key"] },
  { id: "fal", name: "fal.ai", credentials: ["api-key"] },
  {
    id: "supabase",
    name: "Supabase",
    credentials: ["service-role-key", "anon-key", "db-password"],
  },
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
  { id: "telegram", name: "Telegram", credentials: ["bot-token"] },
  { id: "railway", name: "Railway", credentials: ["token"] },
  { id: "clerk", name: "Clerk", credentials: ["secret-key", "publishable-key"] },
  {
    id: "stripe",
    name: "Stripe",
    credentials: ["secret-key", "publishable-key", "webhook-secret"],
  },
  { id: "github", name: "GitHub", credentials: ["token"] },
];
