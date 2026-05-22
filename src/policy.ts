// Command policy — the allow / deny / warn rule engine that runs inside the
// PreToolUse hook after substitution is computed but before it is applied.
//
// See specs/command-policy.md for the full design. In short: each rule has
// optional glob predicates over (key, command, agent); on match, an action
// (allow|deny|warn) with a human-facing reason. Rules are evaluated in
// ascending `ordering` (ties broken by id). First match wins per substitution.
// When several placeholders in one command produce decisions, the strictest
// wins: deny > warn > allow > unmatched.

export type PolicyAction = "allow" | "deny" | "warn";

export interface PolicyRule {
  id: number;
  ordering: number;
  when_key: string | null;
  when_command: string | null;
  when_agent: string | null;
  /**
   * Project predicate — glob match against the matched project's `name`. Null
   * means "any project (or none)". Added in v0.2.5 (Phase 3); existing DBs gain
   * the column via additive migration in Store.
   */
  when_project: string | null;
  action: PolicyAction;
  reason: string | null;
  created_at: string;
}

export interface PolicyContext {
  /** "tool:label" form of the placeholder being substituted. */
  key: string;
  /** The full Bash command that will run, with placeholders still un-substituted. */
  command: string;
  /** Calling agent. Today this is "claude-code"; future agents will identify themselves. */
  agent: string;
  /**
   * The matched project's `name`, or the empty string when no project matches
   * the session's `cwd`. Glob `*` matches both populated names and the empty
   * fallback, so a project-agnostic rule (no `when_project`) is unaffected.
   */
  project: string;
}

export interface PolicyDecision {
  /** "allow" includes the case where no rule matched at all. */
  action: PolicyAction;
  /** The rule that produced the decision, or null when nothing matched. */
  rule: PolicyRule | null;
  /** Human-facing reason; null when no rule matched or rule had no reason. */
  reason: string | null;
}

/**
 * Match a single string against a Phase-1 glob. The only wildcard is `*`,
 * which matches zero or more characters of any kind. A null pattern matches
 * anything (and is how a rule says "I don't care about this field").
 */
export function globMatch(pattern: string | null, input: string): boolean {
  if (pattern == null) return true;
  // Empty pattern is intentionally interpreted as "match empty string only" —
  // a user who wants "match anything" should leave the field null.
  if (pattern === "") return input === "";

  // Escape regex metachars except `*`, then turn `*` into `.*`. Anchor with
  // ^...$ so the whole input must match (not just a prefix).
  const re = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${re}$`).test(input);
}

/**
 * Evaluate a single substitution against the ordered rule list. Returns the
 * first matching rule's action, or `{ action: "allow", rule: null }` when
 * nothing matches (the documented default).
 */
export function evaluateOne(
  rules: PolicyRule[],
  ctx: PolicyContext,
): PolicyDecision {
  for (const r of rules) {
    if (!globMatch(r.when_key, ctx.key)) continue;
    if (!globMatch(r.when_command, ctx.command)) continue;
    if (!globMatch(r.when_agent, ctx.agent)) continue;
    if (!globMatch(r.when_project, ctx.project)) continue;
    return { action: r.action, rule: r, reason: r.reason };
  }
  return { action: "allow", rule: null, reason: null };
}

/**
 * Evaluate every substitution in `keys` (each `"tool:label"`) against the
 * rule list, then collapse to one combined decision. Severity ordering:
 *
 *   deny > warn > allow
 *
 * - If any substitution is denied, the whole command is denied (with that
 *   rule's reason).
 * - Else if any is warned, the command is allowed but the warning's reason
 *   surfaces.
 * - Else the command is allowed.
 *
 * Per-substitution decisions are also returned so callers (audit log,
 * `policy test`) can show every match, not just the winning one.
 */
export interface BulkPolicyDecision {
  /** Combined verdict for the whole command. */
  action: PolicyAction;
  /** The rule that produced the combined verdict, or null when none did. */
  rule: PolicyRule | null;
  /** Combined verdict's reason. */
  reason: string | null;
  /** One entry per input key, in the same order. */
  perKey: { key: string; decision: PolicyDecision }[];
}

export function evaluateAll(
  rules: PolicyRule[],
  command: string,
  agent: string,
  keys: string[],
  project: string = "",
): BulkPolicyDecision {
  const perKey: { key: string; decision: PolicyDecision }[] = [];
  let chosen: PolicyDecision | null = null;
  const rank = (a: PolicyAction): number =>
    a === "deny" ? 2 : a === "warn" ? 1 : 0;

  for (const k of keys) {
    const d = evaluateOne(rules, { key: k, command, agent, project });
    perKey.push({ key: k, decision: d });
    if (chosen == null || rank(d.action) > rank(chosen.action)) chosen = d;
  }

  if (!chosen) {
    // No keys at all — vacuously allow.
    return { action: "allow", rule: null, reason: null, perKey };
  }
  return {
    action: chosen.action,
    rule: chosen.rule,
    reason: chosen.reason,
    perKey,
  };
}
