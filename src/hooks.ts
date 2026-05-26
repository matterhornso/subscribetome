// The three Claude Code hooks.
//
//   PreToolUse       — the ONE load-bearing hook. Substitutes {{stm:...}}
//                      placeholders in Bash commands with real keys via
//                      `updatedInput`. Blocks a raw key being written to a
//                      file by a file-writing tool, and blocks malformed
//                      near-misses.
//   UserPromptSubmit — guardrail. Blocks a prompt that contains a raw key.
//   PostToolUse      — guardrail. Flags command output that leaked a key.
//
// FAIL-SAFE PRINCIPLE: on any unexpected error a hook exits 0 without
// rewriting. The worst case is then a command running with an un-substituted
// placeholder — which simply fails. A hook never leaks a key by failing.
//
// This module NEVER logs a resolved key value.
import { Store } from "./store.ts";
import { findExact, findNearMisses, suggest } from "./grammar.ts";
import { detectKeys } from "./detect.ts";
import { evaluateAll } from "./policy.ts";

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of Bun.stdin.stream()) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/** Block the tool/prompt: reason to stderr (shown to Claude), exit code 2. */
function block(reason: string): never {
  process.stderr.write(reason + "\n");
  process.exit(2);
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Text a file-writing tool would PUT INTO a file — added/written content
 *  only, never text being removed (an Edit's old_string). */
function fileWrittenText(input: any): string[] {
  const out: string[] = [];
  for (const k of ["content", "new_string", "new_str", "new_source"]) {
    if (typeof input?.[k] === "string") out.push(input[k]);
  }
  if (Array.isArray(input?.edits)) {
    for (const e of input.edits) {
      if (typeof e?.new_string === "string") out.push(e.new_string);
    }
  }
  return out;
}

// ---- PreToolUse -----------------------------------------------------------

export async function preToolUse(): Promise<void> {
  let payload: any;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.exit(0); // unparseable input — fail safe
  }

  const toolName: string = payload?.tool_name ?? payload?.tool ?? "";
  const input = payload?.tool_input ?? {};
  const cwd: string =
    typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();

  // A file-writing tool must not persist a raw secret to disk. Block a real,
  // key-shaped string in the written content. A placeholder, by contrast, is
  // harmless in a file (it is only the token — the hook never substitutes into
  // a file) and is the intended form for a .env entry, so it passes through.
  if (FILE_TOOLS.has(toolName)) {
    const hits = fileWrittenText(input).flatMap((t) => detectKeys(t));
    if (hits.length > 0) {
      const kinds = [...new Set(hits.map((h) => h.kind))].join(", ");
      block(
        `subscribetome: this ${toolName} call would write what looks like a real\n` +
          `API key (${kinds}) into a file. Blocked.\n` +
          `Keep keys in the OS keychain — add this one via the dashboard ` +
          `(\`stm dashboard\`),\nthen write its stm placeholder token in the file instead.`,
      );
    }
    process.exit(0);
  }

  if (toolName !== "Bash") process.exit(0);

  const command: string = typeof input?.command === "string" ? input.command : "";
  if (!command) process.exit(0);

  // Near-misses: malformed {{...stm...}} blobs. Never substituted — block with
  // a did-you-mean suggestion.
  const near = findNearMisses(command);
  if (near.length > 0) {
    let known: string[] = [];
    try {
      const s = new Store();
      try {
        known = s.activePlaceholders();
        for (const m of near) {
          try {
            s.recordAudit({
              event: "malformed",
              command,
              agent: "claude-code",
              reason: m.raw,
            });
          } catch {
            /* audit is best-effort */
          }
        }
      } finally {
        s.close();
      }
    } catch {
      /* suggestions + audit are best-effort */
    }
    const lines = near.map((m) => {
      const s = suggest(m.raw, known);
      return `  ${m.raw}${s ? `   → did you mean ${s} ?` : ""}`;
    });
    block(
      `subscribetome: malformed placeholder(s) — NOT substituted:\n` +
        lines.join("\n") +
        `\nValid grammar is {{stm:<tool>:<label>}} (lowercase a-z, 0-9, hyphen).\n` +
        `Run \`stm list\` to see your keys.`,
    );
  }

  const exact = findExact(command);
  if (exact.length === 0) process.exit(0); // nothing to substitute

  let store: Store;
  try {
    store = new Store();
  } catch {
    process.exit(0); // store unavailable — fail safe, command runs unsubstituted
  }

  // Command policy — run BEFORE keychain resolution so a deny rule never
  // touches the keychain (no Touch ID prompt for a request we'll reject).
  // The policy engine sees the command in its un-substituted form, which
  // means the rule predicates and any audit trail never carry the real
  // secret value.
  try {
    // Phase 3: find the project this session is inside (longest-prefix match
    // on `cwd`). Used for two things: the `when.project` predicate, and the
    // per-project `enforce_scope` toggle that synthesizes an implicit deny.
    let project: ReturnType<Store["matchProject"]> = null;
    try {
      project = store.matchProject(cwd);
    } catch {
      /* matchProject is best-effort; null means "no project" */
    }
    const projectName = project?.name ?? "";

    // Phase 3: scope enforcement. If the matched project has enforce_scope=1,
    // any substitution whose (tool, label) is NOT registered as in-scope gets
    // a synthetic deny — same shape as a real policy.deny but with
    // policy_id=null. Evaluated BEFORE the user-authored rule list so the
    // audit trail clearly distinguishes "scope enforcement" from a rule hit.
    if (project && project.enforce_scope === 1) {
      const outOfScope: { tool: string; label: string }[] = [];
      const seen = new Set<string>();
      for (const p of exact) {
        const k = `${p.tool}:${p.label}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (!store.isInProjectScope(project.id, p.tool, p.label)) {
          outOfScope.push({ tool: p.tool, label: p.label });
        }
      }
      if (outOfScope.length > 0) {
        for (const { tool, label } of outOfScope) {
          try {
            store.recordAudit({
              event: "policy.deny",
              tool,
              label,
              command,
              agent: "claude-code",
              // policy_id is intentionally null: this deny did not come from a
              // user-authored rule but from the project's scope-enforcement
              // toggle. The reason string identifies the synthetic source.
              policyId: null,
              reason: `scope enforcement: ${tool}:${label} not in project ${project.name}`,
            });
          } catch {
            /* audit is best-effort */
          }
        }
        store.close();
        const list = outOfScope.map((s) => `${s.tool}:${s.label}`).join(", ");
        block(
          `subscribetome: blocked by scope enforcement on project "${project.name}".\n` +
            `Out-of-scope placeholder(s): ${list}\n` +
            `Add them with: stm project scope ${project.path} <tool>:<label>\n` +
            `Or disable enforcement: stm project enforce ${project.path} off`,
        );
      }
    }

    const rules = store.listPolicies();
    if (rules.length > 0) {
      const keys = [...new Set(exact.map((p) => `${p.tool}:${p.label}`))];
      const decision = evaluateAll(rules, command, "claude-code", keys, projectName);
      // Audit every per-key policy hit so the user can see what fired even
      // when severity collapsed the verdict to one rule. Writes happen on
      // the un-substituted command, before any keychain read.
      for (const pk of decision.perKey) {
        if (pk.decision.action === "deny" || pk.decision.action === "warn") {
          const [tool, label] = pk.key.split(":");
          try {
            store.recordAudit({
              event: pk.decision.action === "deny" ? "policy.deny" : "policy.warn",
              tool,
              label,
              command,
              agent: "claude-code",
              policyId: pk.decision.rule?.id ?? null,
              reason: pk.decision.reason ?? null,
            });
          } catch {
            /* audit is best-effort */
          }
        }
      }
      if (decision.action === "deny") {
        store.close();
        const ruleTag = decision.rule ? `policy rule #${decision.rule.id}` : "policy";
        block(
          `subscribetome: blocked by ${ruleTag}.\n` +
            (decision.reason ? `Reason: ${decision.reason}\n` : "") +
            `The command was NOT substituted and will NOT run.\n` +
            `Inspect the rule with \`stm policy list\`, or test future ` +
            `commands with \`stm policy test <command>\`.`,
        );
      }
      if (decision.action === "warn" && decision.rule) {
        process.stderr.write(
          `subscribetome: policy warning (rule #${decision.rule.id})` +
            (decision.reason ? `: ${decision.reason}` : "") +
            `\n`,
        );
      }
    }
  } catch {
    // Policy evaluation must never bubble. A failure here drops the command
    // back into the un-policed path — but ALSO into the standard fail-safe
    // (an internal error means we exit 0 without rewriting; the command
    // then runs with the literal placeholder and simply fails).
    store.close();
    process.exit(0);
  }

  const resolved = new Map<string, string>();
  const unresolved: string[] = [];
  // Track which (tool,label) pairs we've audited so a command that uses the
  // same placeholder twice writes one substitute row, not two.
  const auditedKeys = new Set<string>();
  try {
    for (const p of exact) {
      if (resolved.has(p.raw)) continue;
      const val = store.resolve(p.tool, p.label);
      if (val == null) unresolved.push(p.raw);
      else resolved.set(p.raw, val);
    }
    // Write audit rows BEFORE closing the store. Unresolved gets its own
    // event class; the success path queues substitute rows here so the
    // store is still open when we write them.
    for (const u of [...new Set(unresolved)]) {
      const m = u.match(/^\{\{stm:([a-z0-9-]+):([a-z0-9-]+)\}\}$/);
      try {
        store.recordAudit({
          event: "unresolved",
          tool: m?.[1] ?? null,
          label: m?.[2] ?? null,
          command,
          agent: "claude-code",
        });
      } catch {
        /* audit is best-effort */
      }
    }
    if (unresolved.length === 0) {
      // Success path — one substitute row per distinct (tool,label).
      for (const p of exact) {
        const k = `${p.tool}:${p.label}`;
        if (auditedKeys.has(k)) continue;
        auditedKeys.add(k);
        try {
          store.recordAudit({
            event: "substitute",
            tool: p.tool,
            label: p.label,
            command,
            agent: "claude-code",
          });
        } catch {
          /* audit is best-effort */
        }
      }
    }
  } catch {
    // Unexpected failure mid-resolution (e.g. a SQLite error). Fail safe:
    // exit 0 with no rewrite — the command then runs with the literal
    // placeholder and simply fails. Never bubble out as a non-zero exit.
    process.exit(0);
  } finally {
    store.close();
  }

  if (unresolved.length > 0) {
    block(
      `subscribetome: cannot resolve placeholder(s): ${[...new Set(unresolved)].join(", ")}\n` +
        `The key is unknown or has been revoked. Run \`stm list\`, or add it in\n` +
        `the dashboard: \`stm dashboard\` (slash command: /stm:dashboard).`,
    );
  }

  // Rebuild the command with every placeholder replaced by its real value.
  //
  // KNOWN LIMITATION: the real key is now an inline argv element of the
  // command the Bash tool executes — briefly visible to a local `ps` while
  // that command runs. This is inherent to injecting a secret into a shell
  // command and is documented in the README. The conversation transcript
  // still only ever holds the placeholder form.
  //
  // resolved.get(p.raw) is non-null for every p here: the unresolved branch
  // above called block(), which exits the process.
  let out = "";
  let last = 0;
  for (const p of exact) {
    out += command.slice(last, p.start) + resolved.get(p.raw)!;
    last = p.end;
  }
  out += command.slice(last);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...input, command: out },
      },
    }),
  );
  process.exit(0);
}

// ---- UserPromptSubmit -----------------------------------------------------

export async function userPromptSubmit(): Promise<void> {
  let payload: any;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }
  const prompt: string =
    payload?.prompt ??
    payload?.userMessage ??
    payload?.user_message ??
    payload?.message ??
    "";
  if (!prompt) process.exit(0);

  // (a) Shape channel: anything that looks like an API key.
  const hits = detectKeys(prompt);
  if (hits.length > 0) {
    const kinds = [...new Set(hits.map((h) => h.kind))].join(", ");
    block(
      `subscribetome: this prompt looks like it contains an API key (${kinds}).\n` +
        `Blocked — keys must never go through the chat; the model would see them.\n` +
        `Add the key out-of-band in the dashboard (\`stm dashboard\`), then refer to\n` +
        `it as {{stm:<tool>:<label>}} — the PreToolUse hook injects it into commands.`,
    );
  }

  // (b) Exact-value channel: a secret stm already manages, pasted verbatim.
  // Catches plain passwords that have no API-key shape (the shape channel
  // above would miss them). Threshold 8 chars so a short value cannot be
  // confused with ordinary prose. Best-effort: if the store is unavailable
  // the shape channel still applied, so fail safe and let the prompt through.
  try {
    const store = new Store();
    let managed = false;
    try {
      managed = store
        .activeKeyValues()
        .some((v) => v.length >= 8 && prompt.includes(v));
    } finally {
      store.close();
    }
    if (managed) {
      block(
        `subscribetome: this prompt contains a secret you manage with stm.\n` +
          `Blocked — keys and passwords must never go through the chat; the model\n` +
          `would see them. Refer to the secret by its {{stm:<tool>:<label>}}\n` +
          `placeholder instead — the PreToolUse hook injects it into commands.`,
      );
    }
  } catch {
    /* store unavailable — shape channel already applied; fail safe */
  }

  process.exit(0);
}

// ---- PostToolUse ----------------------------------------------------------

export async function postToolUse(): Promise<void> {
  let payload: any;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }

  const toolName: string = payload?.tool_name ?? payload?.tool ?? "";
  if (toolName !== "Bash") process.exit(0);

  const input = payload?.tool_input ?? {};
  const command: string = typeof input?.command === "string" ? input.command : "";

  const rawOut =
    payload?.tool_response ?? payload?.tool_output ?? payload?.tool_result ?? "";
  const outText = typeof rawOut === "string" ? rawOut : JSON.stringify(rawOut);
  if (!outText) process.exit(0);

  // (a) Reliable channel: re-resolve the placeholders this command used and
  //     check whether their exact secret values appear in the output. The
  //     transcript keeps the placeholder form, so PostToolUse can resolve the
  //     very same keys PreToolUse substituted — no cross-process state needed.
  const leaked: string[] = [];
  const exact = findExact(command);
  if (exact.length > 0) {
    try {
      const store = new Store();
      try {
        for (const p of exact) {
          const val = store.resolve(p.tool, p.label);
          if (val && outText.includes(val)) leaked.push(p.raw);
        }
      } finally {
        store.close();
      }
    } catch {
      /* best-effort */
    }
  }

  // (b) Best-effort channel: other key-shaped strings in the output.
  const shaped = detectKeys(outText);

  if (leaked.length === 0 && shaped.length === 0) process.exit(0);

  let msg = `subscribetome: this command's output contains what looks like a real API key.\n`;
  if (leaked.length > 0) {
    msg +=
      `A key you manage leaked into output via ${[...new Set(leaked)].join(", ")} ` +
      `— the command likely echoed or errored with its own input.\n`;
  }
  if (shaped.length > 0) {
    msg += `Key-shaped string(s) detected: ${[...new Set(shaped.map((h) => h.kind))].join(", ")}.\n`;
  }
  msg +=
    `PostToolUse runs AFTER the command — this is an alert, not a save: the\n` +
    `value is already in this turn's output. Treat the key as COMPROMISED:\n` +
    `revoke it (\`stm revoke\`), issue a fresh one at the provider, and re-add it\n` +
    `via \`stm dashboard\`. Then re-run the command without echoing the key\n` +
    `(avoid \`set -x\` and verbose/error output that prints it).`;

  // Mode toggle (v0.9.0): STM_POSTTOOLUSE_MODE controls whether a
  // detected leak BLOCKS the agent turn (default — strongest safety,
  // interrupts the model so it can't continue with a known-compromised
  // key in context) or just WARNS (advisory message to stderr, exit 0,
  // agent's flow continues).
  //
  // Warn mode is opt-in for power users running long autonomous flows
  // where an interruption is more costly than a key already leaked
  // into a buffer that's about to be summarised anyway. The default
  // stays block so a passive user hits the safer behavior.
  //
  // Anything other than "warn" (or unset) means block — same as v1.
  const mode = (process.env.STM_POSTTOOLUSE_MODE ?? "block").toLowerCase();
  if (mode === "warn") {
    process.stderr.write(msg + "\n");
    process.stderr.write(
      `(STM_POSTTOOLUSE_MODE=warn — advisory only, not blocking this turn.)\n`,
    );
    process.exit(0);
  }
  block(msg);
}

// ---- SessionStart ---------------------------------------------------------

/** Usage guidance injected into every session so the model knows how to use
 *  stm-managed keys with zero user configuration. */
const SESSION_GUIDANCE =
  "API KEYS — this user manages API keys and tokens with `stm` (subscribetome). " +
  "When a task needs an API key:\n" +
  "- Run `stm list` to see the available keys. Each is addressed by a placeholder " +
  "of the form `{{stm:<tool>:<label>}}`.\n" +
  "- Put the matching placeholder LITERALLY where the key goes in a shell command " +
  "(e.g. `FAL_KEY={{stm:fal:default}} python make_video.py`, or a curl auth header). " +
  "A PreToolUse hook substitutes the real key when the command runs.\n" +
  "- NEVER ask the user to paste a raw key, and never print a key value.\n" +
  "- Keep the placeholder INLINE in the command — do not write it into a file " +
  "(.env, config): the hook substitutes into commands only, not files.\n" +
  "- If a needed key is not listed by `stm list`, tell the user to add it via the " +
  "`/stm:dashboard` slash command — keys are entered out-of-band, never in chat.";

/**
 * Render the project-scope section that gets appended to SESSION_GUIDANCE
 * when the session's cwd matches a registered project. Lists ONLY the keys
 * the user has scoped to this project — the model is told these are the
 * relevant ones, not the full inventory.
 *
 * Adopting project scope is opt-in: when matchProject returns null, this
 * function isn't called and SessionStart emits the unchanged guidance — no
 * regression for users who haven't registered any projects.
 */
function renderProjectScope(
  project: { name: string; path: string },
  scope: { placeholder: string }[],
): string {
  const head =
    `\n\n--- PROJECT SCOPE ---\n` +
    `This session is in **${project.name}** (${project.path}). ` +
    `${scope.length === 0 ? "No keys scoped to this project yet — " +
        "use `stm project scope` to add some, or fall back to `stm list` for the global inventory." :
      `These ${scope.length} key${scope.length === 1 ? " is" : "s are"} in scope for this project:`}\n`;
  if (scope.length === 0) return head;
  return (
    head +
    scope.map((s) => `  - ${s.placeholder}`).join("\n") +
    `\n\nPrefer these placeholders. If the task needs a key not in this list, ` +
    `run \`stm list\` for the global inventory or tell the user to scope a new one.`
  );
}

/**
 * SessionStart hook. Emits stm usage guidance as additive session context.
 * Purely additive — it never blocks. On any error it exits 0 with no output
 * (a missing instruction is harmless; the other hooks still enforce the rules).
 *
 * If the session's `cwd` matches a registered project (longest-prefix), the
 * guidance is appended with the project's scoped key list.
 */
export async function sessionStart(): Promise<void> {
  let payload: any = {};
  try {
    const text = await readStdin();
    if (text.trim()) payload = JSON.parse(text);
  } catch {
    /* unparseable — fall back to no project context */
  }

  const cwd: string =
    typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();

  let additional = SESSION_GUIDANCE;
  try {
    const store = new Store();
    try {
      const project = store.matchProject(cwd);
      if (project) {
        const scope = store.projectScope(project.id);
        additional += renderProjectScope(project, scope);
      }
    } finally {
      store.close();
    }
  } catch {
    /* project lookup is best-effort — never fails the hook */
  }

  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: additional,
        },
      }),
    );
  } catch {
    /* ignore — additive context is best-effort */
  }
  process.exit(0);
}
