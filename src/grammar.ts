// Placeholder grammar for subscribetome.
//
//   {{stm:<tool>:<label>}}
//
// <tool> and <label> are lowercase [a-z0-9-], 1..64 chars each. The pair
// (tool, label) is the global address of a key. Substitution matches this
// grammar EXACTLY — no other form resolves. A near-miss (a {{...}} blob that
// mentions "stm" but is malformed) is never substituted; it is reported so the
// caller can block with a did-you-mean suggestion.

export const SEGMENT_MAX = 64;
const SEGMENT = "[a-z0-9-]{1,64}";
const EXACT = new RegExp(`\\{\\{stm:(${SEGMENT}):(${SEGMENT})\\}\\}`, "g");
// Loose form: any {{...}} blob mentioning "stm". A superset of EXACT, used
// only to surface near-misses — never to resolve.
const LOOSE = /\{\{[^{}]*?stm[^{}]*?\}\}/gi;

export interface Match {
  raw: string;
  start: number;
  end: number;
}
export interface Placeholder extends Match {
  tool: string;
  label: string;
}

/** Every exact, valid placeholder in `text`. */
export function findExact(text: string): Placeholder[] {
  const out: Placeholder[] = [];
  for (const m of text.matchAll(EXACT)) {
    out.push({
      raw: m[0],
      tool: m[1],
      label: m[2],
      start: m.index!,
      end: m.index! + m[0].length,
    });
  }
  return out;
}

/** Every loose {{...stm...}} blob — a superset of the exact matches. */
export function findLoose(text: string): Match[] {
  const out: Match[] = [];
  for (const m of text.matchAll(LOOSE)) {
    out.push({ raw: m[0], start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** True iff `raw` is exactly one valid placeholder and nothing else. */
export function isExact(raw: string): boolean {
  return new RegExp(`^\\{\\{stm:${SEGMENT}:${SEGMENT}\\}\\}$`).test(raw);
}

/** Loose matches that are NOT valid placeholders — the near-misses to block. */
export function findNearMisses(text: string): Match[] {
  return findLoose(text).filter((m) => !isExact(m.raw));
}

/** Normalize arbitrary user input into a valid grammar segment. */
export function normalizeSegment(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SEGMENT_MAX);
}

export function makePlaceholder(tool: string, label: string): string {
  return `{{stm:${tool}:${label}}}`;
}

/** Levenshtein edit distance — for did-you-mean suggestions. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** Closest known placeholder to a malformed one, or null if none is close. */
export function suggest(malformed: string, known: string[]): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const k of known) {
    const d = levenshtein(malformed, k);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  if (best && bestD <= Math.max(4, Math.ceil(best.length * 0.4))) return best;
  return null;
}
