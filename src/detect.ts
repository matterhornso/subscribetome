// Heuristic detection of API-key-shaped strings.
//
// Tier 1 — provider prefixes: high-confidence, low false-positive rate.
// Tier 2 — generic high-entropy: deliberately conservative. It rejects hex
//          hashes, UUIDs, and all-digit strings so it does not fire on git
//          SHAs and similar. Best-effort only.

export interface Hit {
  value: string;
  kind: string;
}

const PREFIXED: { re: RegExp; kind: string }[] = [
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, kind: "anthropic" },
  { re: /sk-proj-[A-Za-z0-9_-]{20,}/g, kind: "openai-project" },
  { re: /sk-[A-Za-z0-9]{20,}/g, kind: "openai" },
  { re: /AKIA[0-9A-Z]{16}/g, kind: "aws-access-key-id" },
  { re: /ASIA[0-9A-Z]{16}/g, kind: "aws-temp-key" },
  { re: /github_pat_[A-Za-z0-9_]{50,}/g, kind: "github-pat" },
  { re: /gh[pousr]_[A-Za-z0-9]{30,}/g, kind: "github-token" },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, kind: "slack-token" },
  { re: /AIza[A-Za-z0-9_-]{35}/g, kind: "google-api-key" },
  { re: /hf_[A-Za-z0-9]{30,}/g, kind: "huggingface" },
  { re: /r8_[A-Za-z0-9]{36,}/g, kind: "replicate" },
  { re: /glpat-[A-Za-z0-9_-]{20,}/g, kind: "gitlab-pat" },
  { re: /dop_v1_[a-f0-9]{40,}/g, kind: "doppler" },
  { re: /sk_live_[A-Za-z0-9]{20,}/g, kind: "stripe-live" },
  {
    re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    kind: "jwt",
  },
];

// Charset includes base64 chars (+ =) so standard-base64 secrets are not
// missed; hex/UUID/all-digit runs are rejected by looksLikeGenericKey below.
const GENERIC = /[A-Za-z0-9_\-+=]{32,200}/g;

/** Shannon entropy (bits/char) of a string. */
function shannon(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let e = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

function looksLikeGenericKey(v: string): boolean {
  if (v.length < 32 || v.length > 200) return false;
  if (/^[0-9]+$/.test(v)) return false; // all digits
  if (/^[a-f0-9]+$/i.test(v)) return false; // hex hash (sha / md5 / git SHA)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    return false; // UUID
  }
  if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) return false; // need letters AND digits
  return shannon(v) >= 3.6;
}

/** Every API-key-shaped string in `text`, de-duplicated. */
export function detectKeys(text: string): Hit[] {
  if (!text) return [];
  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const { re, kind } of PREFIXED) {
    for (const m of text.matchAll(re)) {
      if (!seen.has(m[0])) {
        seen.add(m[0]);
        hits.push({ value: m[0], kind });
      }
    }
  }
  for (const m of text.matchAll(GENERIC)) {
    const v = m[0];
    if (seen.has(v)) continue;
    if ([...seen].some((s) => s.includes(v))) continue; // part of a known key
    if (looksLikeGenericKey(v)) {
      seen.add(v);
      hits.push({ value: v, kind: "high-entropy" });
    }
  }
  return hits;
}
