// Placeholder grammar for subscribetome.
//
//   {{stm:<tool>:<label>}}
//
// <tool> and <label> are lowercase [a-z0-9-], 1..64 chars each. The pair
// (tool, label) is the global address of a key. Substitution matches this
// grammar EXACTLY — no other form resolves. A near-miss (a {{...}} blob that
// mentions "stm" but is malformed) is never substituted; it is reported so the
// caller can block with a did-you-mean suggestion.

const SEGMENT_MAX = 64;
const SEGMENT = "[a-z0-9-]{1,64}";
const EXACT = new RegExp(`\\{\\{stm:(${SEGMENT}):(${SEGMENT})\\}\\}`, "g");
// Opener of an INTENDED placeholder: "{{", optional inner whitespace, then
// "stm" (case-insensitive, so {{STM...}} and {{ stm ...}} surface as
// near-misses). Used only to FIND near-misses — never to resolve. This is
// deliberately broader than a brace-delimited blob: it also catches a malformed
// placeholder with a stray inner "{" (e.g. {{stm:fal:de{fault}}) or a missing
// closing brace (e.g. {{stm:fal:default}), which a "{{...}}" blob regex misses
// entirely — those would otherwise slip through with no did-you-mean.
const OPENER = /\{\{\s*stm/gi;
// Cap a near-miss snippet so a stray "{{stm" with no close doesn't swallow the
// rest of the command into the suggestion text.
const NEARMISS_MAX = 128;

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

/** True iff `raw` is exactly one valid placeholder and nothing else. */
export function isExact(raw: string): boolean {
  return new RegExp(`^\\{\\{stm:${SEGMENT}:${SEGMENT}\\}\\}$`).test(raw);
}

/**
 * Every malformed `{{stm...` opener — the near-misses to block with a
 * did-you-mean. An opener that is the exact start of a VALID placeholder is not
 * a near-miss (it resolves); every other opener is. Each near-miss snippet runs
 * from the opener to whichever comes first: its closing `}}`, the next opener,
 * or a length cap — so the snippet stays tight enough for `suggest()` to score.
 */
export function findNearMisses(text: string): Match[] {
  const exactStarts = new Set(findExact(text).map((p) => p.start));
  const out: Match[] = [];
  for (const m of text.matchAll(OPENER)) {
    const start = m.index!;
    if (exactStarts.has(start)) continue; // a valid placeholder starts here
    const rest = text.slice(start, start + NEARMISS_MAX);
    const closeIdx = rest.indexOf("}}"); // -1 if this opener never closes
    // Next opener AFTER this one's "{{" (search past the leading 2 chars).
    // Non-global on purpose: .search from index 0 of the sliced tail.
    const nextRel = rest.slice(2).search(/\{\{\s*stm/i);
    const nextIdx = nextRel === -1 ? -1 : nextRel + 2;
    let end: number;
    if (closeIdx !== -1 && (nextIdx === -1 || closeIdx < nextIdx)) {
      end = start + closeIdx + 2; // include the closing "}}"
    } else if (nextIdx !== -1) {
      end = start + nextIdx; // stop before the next opener
    } else {
      end = start + rest.length; // no close, no next opener — cap
    }
    out.push({ raw: text.slice(start, end), start, end });
  }
  return out;
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
