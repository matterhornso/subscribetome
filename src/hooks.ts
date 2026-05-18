// The three Claude Code hooks.
//
//   PreToolUse       — the ONE load-bearing hook. Substitutes {{stm:...}}
//                      placeholders in Bash commands with real keys via
//                      `updatedInput`. Blocks placeholders in file-writing
//                      tools and blocks malformed near-misses.
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

/** Collect every file-content string from a file-writing tool's input. */
function fileTextFields(input: any): string[] {
  const out: string[] = [];
  for (const k of ["content", "new_string", "old_string", "new_str", "old_str", "new_source"]) {
    if (typeof input?.[k] === "string") out.push(input[k]);
  }
  if (Array.isArray(input?.edits)) {
    for (const e of input.edits) {
      if (typeof e?.new_string === "string") out.push(e.new_string);
      if (typeof e?.old_string === "string") out.push(e.old_string);
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

  // A placeholder inside a file-writing tool would persist a real key to disk.
  // Never substitute it — block.
  if (FILE_TOOLS.has(toolName)) {
    const hasPlaceholder = fileTextFields(input).some(
      (t) => findExact(t).length > 0 || findNearMisses(t).length > 0,
    );
    if (hasPlaceholder) {
      block(
        `subscribetome: a {{stm:...}} placeholder appears in a ${toolName} call.\n` +
          `Substituting it would write a real API key into a file. Blocked.\n` +
          `Use the placeholder in a Bash command instead — there it is injected\n` +
          `transiently for one command and never persisted.`,
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
      known = s.activePlaceholders();
      s.close();
    } catch {
      /* suggestions are best-effort */
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

  const resolved = new Map<string, string>();
  const unresolved: string[] = [];
  try {
    for (const p of exact) {
      if (resolved.has(p.raw)) continue;
      const val = store.resolve(p.tool, p.label);
      if (val == null) unresolved.push(p.raw);
      else resolved.set(p.raw, val);
    }
  } finally {
    store.close();
  }

  if (unresolved.length > 0) {
    block(
      `subscribetome: cannot resolve placeholder(s): ${[...new Set(unresolved)].join(", ")}\n` +
        `The key is unknown or has been revoked. Run \`stm list\`, or add it in\n` +
        `the dashboard: \`stm dashboard\` (slash command: /subscribetome:dashboard).`,
    );
  }

  // Rebuild the command with every placeholder replaced by its real value.
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

  const hits = detectKeys(prompt);
  if (hits.length === 0) process.exit(0);

  const kinds = [...new Set(hits.map((h) => h.kind))].join(", ");
  block(
    `subscribetome: this prompt looks like it contains an API key (${kinds}).\n` +
      `Blocked — keys must never go through the chat; the model would see them.\n` +
      `Add the key out-of-band in the dashboard (\`stm dashboard\`), then refer to\n` +
      `it as {{stm:<tool>:<label>}} — the PreToolUse hook injects it into commands.`,
  );
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
    `Flagged so the secret is not trusted into the conversation. Re-run without\n` +
    `echoing the key (avoid \`set -x\` and verbose/error output that prints it).`;
  block(msg);
}
