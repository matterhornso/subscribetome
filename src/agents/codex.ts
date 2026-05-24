// Codex adapter — Workstream C, Option 1: session-env mode.
//
// Spec: specs/cross-platform-and-codex.md §6.
//
// WHY this is its own module:
// Codex CLI's PreToolUse hook does NOT support `updatedInput`. The v1
// per-command rewrite (placeholder → real key inside `updatedInput`)
// that Claude Code uses cannot port. Codex hooks today can only deny
// or add context. So Codex support is NOT a port of the Claude Code
// hook — it is a different injection model.
//
// THE MODEL — "session-env":
//   1. `stm codex` resolves the user's active keys.
//   2. Each key becomes an env var named `STM_<TOOL>_<LABEL>` (uppercased,
//      hyphens → underscores). Determinism is the contract: the same
//      tool/label pair always maps to the same env var, so the user can
//      prompt codex with "use $STM_OPENAI_DEFAULT" or simply let the
//      agent discover them via `env`.
//   3. The launcher spawns `codex` with those vars in the child's process
//      env AND with two `--config` flags telling Codex's
//      [shell_environment_policy] to inherit them into agent shell
//      subprocesses. Without the explicit policy, Codex's default
//      scrubs anything matching KEY/SECRET/TOKEN — defensible behaviour
//      but it would block us, which is why the policy override is part
//      of the launcher and not the user's config.
//
// SECURITY POSTURE — honest and weaker than Claude Code:
//   - The real key value sits in codex's process environment for the
//     entire session, not substituted per command. A command that
//     dumps its environment can surface it. The README and the CLI
//     banner state this verbatim. The dashboard pill shows
//     "Codex: session-env mode".
//   - Secrets are passed to the child via spawn({ env }) — they NEVER
//     appear in argv. The `--config` flags carry only policy names,
//     not values.
//   - The launcher prints no key value. The banner names env vars
//     by name only.
//
// SCOPE-AWARENESS:
//   - When `cwd` matches a registered project (longest-prefix), the
//     launcher injects ONLY that project's scoped keys. Identical
//     posture to SessionStart on Claude Code: the agent gets a
//     narrower view than "all keys this user has".
//   - When no project matches, ALL active keys are injected. This
//     is the only viable default for an unregistered cwd — the
//     alternative ("inject nothing") would silently break Codex
//     for any user who hasn't run `stm project add`.
//
// TESTABILITY:
//   - `keyEnvName` and `buildInjectionPlan` are pure functions.
//   - The launcher takes an injectable `spawn` so we can verify the
//     exact argv + env passed to codex without actually requiring
//     the Codex CLI to be installed.

import { spawn as nodeSpawn } from "node:child_process";
import { Store } from "../store.ts";
import { activeKeyStore } from "../keychain.ts";

/**
 * Deterministic env-var name for a (tool, label) pair. Uppercased,
 * with characters outside [A-Z0-9_] replaced by underscores.
 *
 * Examples:
 *   openai:default        → STM_OPENAI_DEFAULT
 *   anthropic:admin-key   → STM_ANTHROPIC_ADMIN_KEY
 *   openrouter:rotated-2  → STM_OPENROUTER_ROTATED_2
 *
 * Collision risk is intentional and visible: if a user has both
 * `openai:default` and `openai-default:default`, both map to the same
 * env var. The launcher detects collisions and refuses to start so the
 * user sees the conflict rather than getting a silent overwrite.
 */
export function keyEnvName(tool: string, label: string): string {
  const safe = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return `STM_${safe(tool)}_${safe(label)}`;
}

export interface InjectionEntry {
  /** Source tool name as registered in `tools` table. */
  tool: string;
  /** Source label as registered in `keys` table. */
  label: string;
  /** The deterministic env var name (no value). */
  envName: string;
  /** The placeholder form, for logging/audit only. */
  placeholder: string;
}

export interface InjectionPlan {
  /**
   * The env-var-name → key (tool, label) pairs that will be injected.
   * Built BEFORE the keychain is read, so a plan is safe to log /
   * inspect — it never carries a value.
   */
  entries: InjectionEntry[];
  /**
   * Pairs of (tool, label) entries that map to the same envName as a
   * sibling. When non-empty, the launcher must refuse: silently
   * overwriting one secret with another is exactly the failure mode
   * the spec warns about.
   */
  collisions: { envName: string; tools: string[] }[];
  /** Project the cwd matched (longest-prefix) or null. */
  project: { id: number; name: string; path: string } | null;
  /**
   * True when we picked the project-scoped subset, false when we fell
   * back to "all active keys". Surfaced in the banner so the user knows
   * exactly which keys their codex session can see.
   */
  scoped: boolean;
}

/**
 * Build the injection plan WITHOUT touching the keychain. Reads only
 * the inventory rows + project scope. Pure-ish: the only side effect
 * is the store read.
 *
 * The store is passed in so daemon-hosted callers can reuse their
 * long-lived handle; tests pass a fresh in-memory Store.
 */
export function buildInjectionPlan(opts: {
  store: Store;
  cwd: string;
}): InjectionPlan {
  const { store, cwd } = opts;
  const project = store.matchProject(cwd);

  // Decide the candidate (tool, label) set.
  let pairs: { tool: string; label: string }[] = [];
  let scoped = false;
  if (project) {
    const scope = store.projectScope(project.id);
    if (scope.length > 0) {
      pairs = scope.map((s) => ({ tool: s.tool, label: s.label }));
      scoped = true;
    }
    // If a project matches but its scope is empty, fall through to "all
    // active keys" — the launcher would otherwise inject nothing, which
    // is a strictly worse default than telling the user nothing is in
    // scope and using the global inventory.
  }
  if (pairs.length === 0) {
    pairs = store
      .listKeys()
      .filter((k) => k.status === "active")
      .map((k) => ({ tool: k.tool, label: k.label }));
  }

  // Map to env var names; detect collisions.
  const byEnv = new Map<string, { tool: string; label: string }[]>();
  for (const p of pairs) {
    const en = keyEnvName(p.tool, p.label);
    const bucket = byEnv.get(en) ?? [];
    bucket.push(p);
    byEnv.set(en, bucket);
  }
  const collisions: InjectionPlan["collisions"] = [];
  const entries: InjectionEntry[] = [];
  for (const [envName, group] of byEnv) {
    if (group.length > 1) {
      collisions.push({
        envName,
        tools: group.map((g) => `${g.tool}:${g.label}`),
      });
      continue;
    }
    const [p] = group;
    entries.push({
      tool: p.tool,
      label: p.label,
      envName,
      placeholder: `{{stm:${p.tool}:${p.label}}}`,
    });
  }
  // Stable order — alphabetical by env name. Makes the banner reproducible
  // and the test assertions order-independent.
  entries.sort((a, b) => a.envName.localeCompare(b.envName));

  return {
    entries,
    collisions,
    project: project ? { id: project.id, name: project.name, path: project.path } : null,
    scoped,
  };
}

/**
 * Pull each entry's real value from the keychain, returning a flat
 * env-var-name → secret map. Errors per-entry are NOT swallowed: the
 * launcher refuses to start if any required key can't be resolved,
 * rather than half-injecting and letting codex run with gaps.
 *
 * NEVER LOGS A VALUE — only env names appear in any thrown error.
 */
export function resolveInjectionValues(opts: {
  store: Store;
  plan: InjectionPlan;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of opts.plan.entries) {
    const v = opts.store.resolve(e.tool, e.label);
    if (v == null) {
      throw new Error(
        `cannot resolve ${e.envName} (key ${e.tool}:${e.label} missing, ` +
          `revoked, or not present in the keystore)`,
      );
    }
    out[e.envName] = v;
  }
  return out;
}

/**
 * The Codex `--config` flags we always emit. They tell Codex's
 * [shell_environment_policy] to pass our STM_* env vars through to
 * agent shell subprocesses. Without these, Codex's defaults would
 * scrub anything matching the KEY/SECRET/TOKEN pattern (per the spec).
 *
 * Values are NOT in these flags — only names. They appear in argv,
 * which is fine: env-var NAMES are not secret.
 *
 * Pattern-based `include_only` (`STM_*`) is intentional: any future
 * STM_* var we add (e.g. STM_AGENT or STM_SESSION metadata) is
 * automatically usable from agent shells without a launcher change.
 */
export function codexConfigOverrides(): string[] {
  return [
    // Codex CLI accepts `-c KEY=VALUE` to override a single config dotted
    // path. (See `codex --help`; same as `config` block of `config.toml`.)
    // We override the two fields that gate env passthrough.
    "-c",
    'shell_environment_policy.inherit="all"',
    "-c",
    'shell_environment_policy.include_only=["STM_*"]',
  ];
}

/**
 * The injectable spawn surface. We only use `spawn` (not `exec`/
 * `spawnSync`) because codex is a long-running interactive process —
 * we forward stdio and wait for it to exit.
 */
export interface LaunchSpawnFn {
  (
    command: string,
    args: readonly string[],
    options: {
      env: NodeJS.ProcessEnv;
      stdio: "inherit";
      detached?: boolean;
    },
  ): {
    on(event: "exit" | "error", listener: (...a: any[]) => void): void;
  };
}

export interface LaunchResult {
  /** Exit code of the codex child, or null if the process was signalled. */
  code: number | null;
  /** The signal that terminated the child, if any. */
  signal: NodeJS.Signals | null;
}

/**
 * Spawn codex with the resolved env vars and pass-through args. Returns
 * a promise that resolves when codex exits — the caller propagates the
 * exit code to `stm codex`'s own exit code.
 *
 * `userArgs` is forwarded verbatim AFTER our `--config` flags. Codex
 * accepts repeated `-c` overrides without precedence surprises (later
 * `-c` wins on conflict, which is fine — the user can override our
 * defaults if they really want to).
 */
export function launchCodex(opts: {
  values: Record<string, string>;
  userArgs: readonly string[];
  parentEnv?: NodeJS.ProcessEnv;
  spawnFn?: LaunchSpawnFn;
  codexBinary?: string;
}): Promise<LaunchResult> {
  const spawnFn = opts.spawnFn ?? (nodeSpawn as unknown as LaunchSpawnFn);
  const codex = opts.codexBinary ?? "codex";
  const parentEnv = opts.parentEnv ?? process.env;

  const env: NodeJS.ProcessEnv = { ...parentEnv, ...opts.values };
  const args = [...codexConfigOverrides(), ...opts.userArgs];

  return new Promise<LaunchResult>((resolve, reject) => {
    let resolved = false;
    let child: ReturnType<LaunchSpawnFn>;
    try {
      child = spawnFn(codex, args, { env, stdio: "inherit" });
    } catch (e) {
      reject(e);
      return;
    }
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (resolved) return;
      resolved = true;
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `codex binary not found on PATH. Install it from ` +
              `https://github.com/openai/codex and re-run \`stm codex\`.`,
          ),
        );
      } else {
        reject(err);
      }
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (resolved) return;
      resolved = true;
      resolve({ code, signal });
    });
  });
}

/** Human banner printed to stderr at launch time. Lists env-var NAMES
 *  only (never values). Surfaces the spec's "weaker than Claude Code"
 *  framing verbatim so the user can never miss it.
 *
 *  `hooks` is the optional v0.4.1 status from `codexDoctor()` — when
 *  present, the banner adds a one-liner so users know whether the
 *  UserPromptSubmit/SessionStart guardrails are wired into Codex.
 *  Missing guardrails are not a hard error: codex still launches,
 *  the env injection still works. But the banner says so honestly so
 *  the user can decide whether to install them. */
export function launchBanner(
  plan: InjectionPlan,
  hooks?: {
    ok: boolean;
    blockPresent: boolean;
    blockUpToDate: boolean;
    configPresent: boolean;
  },
): string {
  const lines: string[] = [];
  lines.push("stm codex — session-env mode (specs/cross-platform-and-codex.md §6)");
  if (plan.project && plan.scoped) {
    lines.push(
      `  scope:    project "${plan.project.name}" (${plan.project.path})`,
    );
  } else if (plan.project && !plan.scoped) {
    lines.push(
      `  scope:    project "${plan.project.name}" matched but has no scoped keys — using ALL active keys`,
    );
  } else {
    lines.push(`  scope:    no project registered for this cwd — using ALL active keys`);
  }
  if (plan.entries.length === 0) {
    lines.push("  keys:     (none) — codex will launch with no stm-managed env vars");
  } else {
    lines.push(`  keys:     ${plan.entries.length} env var${plan.entries.length === 1 ? "" : "s"} injected:`);
    for (const e of plan.entries) {
      lines.push(`              ${e.envName}   ← ${e.placeholder}`);
    }
  }
  if (hooks) {
    if (hooks.ok) {
      lines.push(
        `  guards:   UserPromptSubmit + SessionStart installed in ~/.codex/config.toml`,
      );
    } else if (!hooks.configPresent) {
      lines.push(
        `  guards:   ~/.codex/config.toml not found — run \`stm codex install-hooks\` to add the guardrails`,
      );
    } else if (!hooks.blockPresent) {
      lines.push(
        `  guards:   NOT installed — run \`stm codex install-hooks\` to add the UserPromptSubmit + SessionStart guards`,
      );
    } else if (!hooks.blockUpToDate) {
      lines.push(
        `  guards:   installed but OUT OF DATE — run \`stm codex install-hooks\` to refresh`,
      );
    } else {
      lines.push(
        `  guards:   issue with hook scripts on disk — run \`stm codex doctor\``,
      );
    }
  }
  lines.push(
    "  posture:  the real key sits in codex's process environment for the whole",
  );
  lines.push(
    "            session. A command that dumps its environment can surface it.",
  );
  lines.push(
    "            This is WEAKER than Claude Code's per-command injection.",
  );
  return lines.join("\n") + "\n";
}

/**
 * One-shot human label for `stm status` and the dashboard pill. The
 * Codex side of the v1 surface is "session-env mode" until openai/
 * codex#18491 lands `updatedInput`, at which point we add a third
 * mode (per-command rewrite) and label this one explicitly as the
 * legacy mode.
 */
export function codexAgentLabel(): string {
  return "Codex (session-env mode)";
}

/**
 * The fixed label for the v1 Claude Code adapter, paired with
 * `codexAgentLabel()` everywhere the active agents list is rendered.
 * Kept beside the codex label so future hooks adapters (Cursor,
 * opencode) drop into the same surface without growing scattered
 * label literals.
 */
export function claudeCodeAgentLabel(): string {
  return "Claude Code (per-command rewrite)";
}

/**
 * Convenience for `stm status` / dashboard: every agent stm supports
 * today, in stable order. The KeyStore decides what storage layer
 * those agents read from; this list is independent.
 *
 * `activeKeyStore` is dereferenced for its side effect of resolving
 * the backend so the call doesn't lie about a backend we can't reach
 * — but the keystore label itself is rendered separately.
 */
export function listSupportedAgents(): { id: string; label: string }[] {
  // Touch the keystore so a misconfigured host still surfaces the
  // resolver error from the same code path that lists agents.
  try {
    activeKeyStore();
  } catch {
    /* the agent list is independent of keystore health */
  }
  return [
    { id: "claude-code", label: claudeCodeAgentLabel() },
    { id: "codex", label: codexAgentLabel() },
  ];
}
