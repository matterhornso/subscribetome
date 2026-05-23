// Spend-provider registry.
//
// Every catalog entry whose `supportsUsage` is true must have a
// corresponding entry in PROVIDERS. The orchestrator in src/sync.ts
// looks providers up by tool id, so the catalog and registry stay in
// lockstep — a build-time check would be nice; for now the test suite
// asserts the invariant.
import type { SpendProvider } from "./types.ts";
import { openaiProvider } from "./openai.ts";
import { anthropicProvider } from "./anthropic.ts";

export type { SpendProvider } from "./types.ts";
export { currentMonthWindow } from "./types.ts";

export const PROVIDERS: Record<string, SpendProvider> = {
  [openaiProvider.id]: openaiProvider,
  [anthropicProvider.id]: anthropicProvider,
};

export function getProvider(id: string): SpendProvider | null {
  return PROVIDERS[id] ?? null;
}

export function listProviderIds(): string[] {
  return Object.keys(PROVIDERS).sort();
}
