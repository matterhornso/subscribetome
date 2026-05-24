#!/usr/bin/env bun
// subscribetome CLI — `stm`.
//
//   stm add --tool <name> [--label <l>] [--plan <p>] [--cost <usd>]
//                                              key value is read from stdin
//   stm list                                   show inventory + spend
//   stm resolve {{stm:<tool>:<label>}}          print a key value (local use)
//   stm revoke <tool> <label>                   mark a key revoked
//   stm import [dir...]                         scan .env files for keys
//   stm dashboard                               start daemon, open the web UI
//   stm daemon                                  run the daemon in foreground
//   stm stop                                    stop the daemon
//   stm status                                  daemon + inventory summary
//   stm hook <pretooluse|posttooluse|userpromptsubmit|sessionstart>  (called by hooks)
import { Store, type AuditEvent } from "./store.ts";
import { preToolUse, postToolUse, userPromptSubmit, sessionStart } from "./hooks.ts";
import { evaluateAll, type PolicyAction } from "./policy.ts";
import { findExact } from "./grammar.ts";
import { syncAll, syncProvider } from "./sync.ts";
import { listProviderIds } from "./providers/index.ts";
import {
  buildInjectionPlan,
  resolveInjectionValues,
  launchCodex,
  launchBanner,
} from "./agents/codex.ts";

/**
 * Parse a friendly duration like `30s`, `5m`, `2h`, `7d` into milliseconds.
 * Returns null on a malformed input.
 */
function parseDuration(s: string): number | null {
  const m = s.trim().match(/^(\d+)\s*([smhd])$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

function parseFlags(args: string[]): {
  flags: Record<string, string>;
  positional: string[];
} {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[a.slice(2)] = args[++i];
      } else {
        flags[a.slice(2)] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write("Paste the key value, then press Ctrl-D:\n");
  }
  const chunks: Uint8Array[] = [];
  for await (const c of Bun.stdin.stream()) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function printTable(head: string[], rows: string[][]): void {
  const w = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (r: string[]) =>
    "  " + r.map((c, i) => (c ?? "").padEnd(w[i])).join("  ");
  process.stdout.write(fmt(head) + "\n");
  for (const r of rows) process.stdout.write(fmt(r) + "\n");
}

// ---- commands -------------------------------------------------------------

async function addCmd(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const tool = flags.tool ?? "";
  const label = flags.label ?? "default";
  if (!tool) {
    process.stderr.write(
      "usage: stm add --tool <name> [--label <label>] [--plan <plan>] " +
        "[--cost <usd>] [--renews <YYYY-MM-DD>] [--display <name>]\n" +
        "       the key value is read from stdin\n",
    );
    process.exit(1);
  }
  const value = await readAllStdin();
  if (!value) {
    process.stderr.write("error: no key value received on stdin\n");
    process.exit(1);
  }
  const store = new Store();
  try {
    if (flags.plan || flags.cost || flags.renews || flags.display) {
      store.upsertTool({
        name: tool,
        displayName: flags.display,
        plan: flags.plan ?? null,
        monthlyCost: flags.cost ? Number(flags.cost) : null,
        renewsOn: flags.renews ?? null,
      });
    }
    const k = store.addKey({
      tool,
      label,
      value,
      source: "manual",
      displayName: flags.display,
    });
    process.stdout.write(
      `added ${k.placeholder}\n` +
        `use that placeholder in any Bash command; the PreToolUse hook injects the real key.\n`,
    );
  } catch (e: any) {
    process.stderr.write(`error: ${e?.message ?? e}\n`);
    process.exit(1);
  } finally {
    store.close();
  }
}

function listCmd(): void {
  const store = new Store();
  try {
    const tools = store.listTools();
    const keys = store.listKeys();
    if (tools.length === 0) {
      process.stdout.write(
        "No tools or keys yet.\n" +
          "  Add one in the dashboard:  stm dashboard\n" +
          "  Or on the CLI:             stm add --tool <name> --label <label>\n",
      );
      return;
    }
    process.stdout.write("\nAPI KEYS\n");
    if (keys.length === 0) {
      process.stdout.write("  (none)\n");
    } else {
      printTable(
        ["PLACEHOLDER", "STATUS", "SOURCE", "ADDED"],
        keys.map((k) => [k.placeholder, k.status, k.source, k.created_at.slice(0, 10)]),
      );
    }
    process.stdout.write("\nSUBSCRIPTIONS\n");
    printTable(
      ["TOOL", "PLAN", "MONTHLY", "RENEWS"],
      tools.map((t) => [
        t.display_name,
        t.plan ?? "-",
        t.monthly_cost != null ? `$${t.monthly_cost}` : "-",
        t.renews_on ?? "-",
      ]),
    );
    process.stdout.write(
      `\n  Total declared monthly spend: $${store.monthlySpend().toFixed(2)}\n\n`,
    );
  } finally {
    store.close();
  }
}

function resolveCmd(args: string[]): void {
  // `stm resolve` prints a real key value. Refuse when stdout is not a
  // terminal — piped, redirected, or invoked by an agent — so the value
  // cannot be swept into a file or a conversation transcript.
  if (!process.stdout.isTTY) {
    process.stderr.write(
      "stm resolve prints a real key and only runs in an interactive terminal.\n" +
        "Its output was redirected or captured — refusing, so the key is not\n" +
        "placed somewhere it must not go.\n",
    );
    process.exit(1);
  }
  let tool: string | undefined;
  let label: string | undefined;
  if (args.length === 1) {
    const m = args[0].match(/^\{\{stm:([a-z0-9-]{1,64}):([a-z0-9-]{1,64})\}\}$/);
    if (!m) {
      process.stderr.write(
        "usage: stm resolve {{stm:<tool>:<label>}}  |  stm resolve <tool> <label>\n",
      );
      process.exit(1);
    }
    tool = m[1];
    label = m[2];
  } else if (args.length >= 2) {
    tool = args[0];
    label = args[1];
  } else {
    process.stderr.write("usage: stm resolve {{stm:<tool>:<label>}}\n");
    process.exit(1);
  }
  const store = new Store();
  try {
    const v = store.resolve(tool!, label!);
    if (v == null) {
      process.stderr.write(`no active key for ${tool}:${label}\n`);
      process.exit(1);
    }
    process.stdout.write(v + "\n");
  } finally {
    store.close();
  }
}

// ---- policy ---------------------------------------------------------------

function policyHelp(): void {
  process.stdout.write(
    `subscribetome — command policy\n\n` +
      `  stm policy list                            list every rule (in order)\n` +
      `  stm policy add --then <allow|deny|warn>\n` +
      `       [--when-key <glob>] [--when-command <glob>] [--when-agent <glob>]\n` +
      `       [--when-project <glob>]\n` +
      `       [--reason "..."] [--order <n>]        add a rule\n` +
      `  stm policy remove <id>                     delete one rule by id\n` +
      `  stm policy test "<bash command>"           dry-run: which rule fires?\n` +
      `\nGlob: \`*\` matches any run of characters. An omitted predicate matches anything.\n` +
      `Default action when no rule matches: allow. To get default-deny, add a final\n` +
      `catch-all rule with high order, e.g.:\n` +
      `  stm policy add --then deny --order 999 --reason "default deny"\n` +
      `\n--when-project matches the registered project NAME (longest-prefix match\n` +
      `on the session's cwd; see \`stm project list\`). Use it for "this rule only\n` +
      `applies inside this project".\n`,
  );
}

function policyListCmd(): void {
  const store = new Store();
  try {
    const rules = store.listPolicies();
    if (rules.length === 0) {
      process.stdout.write(
        "No policy rules.\n  Add one: stm policy add --then deny --when-key 'stripe:*'\n",
      );
      return;
    }
    printTable(
      ["ID", "ORDER", "KEY", "COMMAND", "AGENT", "PROJECT", "ACTION", "REASON"],
      rules.map((r) => [
        String(r.id),
        String(r.ordering),
        r.when_key ?? "*",
        r.when_command ?? "*",
        r.when_agent ?? "*",
        r.when_project ?? "*",
        r.action,
        r.reason ?? "",
      ]),
    );
  } finally {
    store.close();
  }
}

function policyAddCmd(args: string[]): void {
  const { flags } = parseFlags(args);
  const then = flags.then;
  if (then !== "allow" && then !== "deny" && then !== "warn") {
    process.stderr.write(
      "usage: stm policy add --then <allow|deny|warn> [--when-key g] " +
        "[--when-command g] [--when-agent g] [--when-project g] [--reason \"...\"] [--order n]\n",
    );
    process.exit(1);
  }
  const order = flags.order ? Number(flags.order) : undefined;
  if (order !== undefined && !Number.isFinite(order)) {
    process.stderr.write(`error: --order must be a number\n`);
    process.exit(1);
  }
  const store = new Store();
  try {
    const rule = store.addPolicy({
      ordering: order,
      whenKey: flags["when-key"] ?? null,
      whenCommand: flags["when-command"] ?? null,
      whenAgent: flags["when-agent"] ?? null,
      whenProject: flags["when-project"] ?? null,
      action: then as PolicyAction,
      reason: flags.reason ?? null,
    });
    process.stdout.write(
      `added policy #${rule.id} (order ${rule.ordering}): ` +
        `key=${rule.when_key ?? "*"} command=${rule.when_command ?? "*"} ` +
        `agent=${rule.when_agent ?? "*"} project=${rule.when_project ?? "*"} ` +
        `→ ${rule.action}` +
        (rule.reason ? ` (${rule.reason})` : "") +
        `\n`,
    );
  } finally {
    store.close();
  }
}

function policyRemoveCmd(args: string[]): void {
  const id = Number(args[0]);
  if (!Number.isFinite(id) || id <= 0) {
    process.stderr.write("usage: stm policy remove <id>\n");
    process.exit(1);
  }
  const store = new Store();
  try {
    const ok = store.removePolicy(id);
    if (!ok) {
      process.stderr.write(`no such policy: #${id}\n`);
      process.exit(1);
    }
    process.stdout.write(`removed policy #${id}\n`);
  } finally {
    store.close();
  }
}

function policyTestCmd(args: string[]): void {
  const command = args.join(" ").trim();
  if (!command) {
    process.stderr.write('usage: stm policy test "<bash command with {{stm:..}} placeholder(s)>"\n');
    process.exit(1);
  }
  const exact = findExact(command);
  if (exact.length === 0) {
    process.stdout.write(
      `No stm placeholders in this command — policy not consulted. Verdict: allow.\n`,
    );
    return;
  }
  const keys = [...new Set(exact.map((p) => `${p.tool}:${p.label}`))];
  const store = new Store();
  try {
    const rules = store.listPolicies();
    // `stm policy test` runs from a shell — `process.cwd()` is the user's
    // current directory, the same signal Claude Code's PreToolUse uses. Pass
    // the matched project name so `when.project` predicates fire as they
    // would at runtime.
    const project = store.matchProject(process.cwd());
    const decision = evaluateAll(
      rules,
      command,
      "claude-code",
      keys,
      project?.name ?? "",
    );
    process.stdout.write(`Verdict: ${decision.action.toUpperCase()}`);
    if (decision.rule) {
      process.stdout.write(` (rule #${decision.rule.id})`);
    } else {
      process.stdout.write(` (no rule matched — default allow)`);
    }
    process.stdout.write("\n");
    if (decision.reason) process.stdout.write(`Reason: ${decision.reason}\n`);
    process.stdout.write(`\nPer-substitution:\n`);
    for (const p of decision.perKey) {
      const r = p.decision.rule;
      process.stdout.write(
        `  ${p.key.padEnd(28)} → ${p.decision.action}` +
          (r ? ` (rule #${r.id})` : ` (no match)`) +
          `\n`,
      );
    }
  } finally {
    store.close();
  }
}

// ---- project --------------------------------------------------------------

function projectHelp(): void {
  process.stdout.write(
    `subscribetome — per-project key scope\n\n` +
      `  stm project add <path> <name>                    register a project\n` +
      `  stm project list                                 summary of all projects\n` +
      `  stm project show <path>                          full scope + placeholders\n` +
      `  stm project scope <path> <tool>:<label>          add a (tool,label) to scope\n` +
      `  stm project unscope <path> <tool>:<label>        remove one (tool,label)\n` +
      `  stm project enforce <path> <on|off>              toggle scope enforcement\n` +
      `  stm project rename <path> <new-name>             change the display name\n` +
      `  stm project remove <path>                        drop the project + scope\n` +
      `\nWhen a Claude Code session opens in a path that matches a registered\n` +
      `project (longest-prefix wins), SessionStart emits scoped guidance — the\n` +
      `model is told about ONLY that project's keys, not the global inventory.\n` +
      `Default behaviour for unregistered paths is unchanged.\n` +
      `\nEnforcement (off by default): when ON, PreToolUse refuses to substitute\n` +
      `any placeholder that isn't in this project's scope. Off = guidance only.\n`,
  );
}

function parseToolLabel(s: string): { tool: string; label: string } {
  const m = s.match(/^([a-z0-9-]+):([a-z0-9-]+)$/);
  if (!m) {
    process.stderr.write(
      `error: expected <tool>:<label>, got "${s}". Both segments are lowercase a-z, 0-9, hyphen.\n`,
    );
    process.exit(1);
  }
  return { tool: m[1], label: m[2] };
}

function projectAddCmd(args: string[]): void {
  if (args.length < 2) {
    process.stderr.write("usage: stm project add <path> <name>\n");
    process.exit(1);
  }
  const [path, ...rest] = args;
  const name = rest.join(" ").trim();
  const store = new Store();
  try {
    const existing = store.getProjectByPath(path);
    if (existing) {
      process.stderr.write(
        `error: a project at "${existing.path}" already exists (id ${existing.id}, name "${existing.name}")\n`,
      );
      process.exit(1);
    }
    const p = store.addProject({ path, name });
    process.stdout.write(`added project #${p.id} "${p.name}" at ${p.path}\n`);
  } catch (e: any) {
    process.stderr.write(`error: ${e?.message ?? e}\n`);
    process.exit(1);
  } finally {
    store.close();
  }
}

function projectListCmd(): void {
  const store = new Store();
  try {
    const projects = store.listProjects();
    if (projects.length === 0) {
      process.stdout.write(
        "No projects.\n  Add one: stm project add <path> <name>\n",
      );
      return;
    }
    printTable(
      ["ID", "NAME", "PATH", "IN SCOPE", "ENFORCE"],
      projects.map((p) => [
        String(p.id),
        p.name,
        p.path,
        String(store.projectScope(p.id).length),
        p.enforce_scope === 1 ? "on" : "off",
      ]),
    );
  } finally {
    store.close();
  }
}

function projectShowCmd(args: string[]): void {
  const [pathArg] = args;
  if (!pathArg) {
    process.stderr.write("usage: stm project show <path>\n");
    process.exit(1);
  }
  const store = new Store();
  try {
    const p = store.getProjectByPath(pathArg);
    if (!p) {
      process.stderr.write(`no project at "${pathArg}"\n`);
      process.exit(1);
    }
    process.stdout.write(
      `#${p.id}  ${p.name}\n` +
        `    path:    ${p.path}\n` +
        `    added:   ${p.created_at.slice(0, 10)}\n` +
        `    enforce: ${p.enforce_scope === 1 ? "on" : "off"}` +
        (p.enforce_scope === 1
          ? "  (out-of-scope placeholders will be denied)"
          : "  (guidance only)") +
        `\n\n` +
        `  Scope:\n`,
    );
    const scope = store.projectScope(p.id);
    if (scope.length === 0) {
      process.stdout.write(
        `    (none) — add with: stm project scope ${p.path} <tool>:<label>\n`,
      );
    } else {
      for (const s of scope) {
        process.stdout.write(`    ${s.placeholder}\n`);
      }
    }
    process.stdout.write("\n");
  } finally {
    store.close();
  }
}

function projectScopeCmd(args: string[]): void {
  const [pathArg, kl] = args;
  if (!pathArg || !kl) {
    process.stderr.write("usage: stm project scope <path> <tool>:<label>\n");
    process.exit(1);
  }
  const { tool, label } = parseToolLabel(kl);
  const store = new Store();
  try {
    const p = store.getProjectByPath(pathArg);
    if (!p) {
      process.stderr.write(`no project at "${pathArg}"\n`);
      process.exit(1);
    }
    store.addProjectScope(p.id, tool, label);
    process.stdout.write(`scoped ${tool}:${label} to "${p.name}"\n`);
  } catch (e: any) {
    process.stderr.write(`error: ${e?.message ?? e}\n`);
    process.exit(1);
  } finally {
    store.close();
  }
}

function projectUnscopeCmd(args: string[]): void {
  const [pathArg, kl] = args;
  if (!pathArg || !kl) {
    process.stderr.write("usage: stm project unscope <path> <tool>:<label>\n");
    process.exit(1);
  }
  const { tool, label } = parseToolLabel(kl);
  const store = new Store();
  try {
    const p = store.getProjectByPath(pathArg);
    if (!p) {
      process.stderr.write(`no project at "${pathArg}"\n`);
      process.exit(1);
    }
    const ok = store.removeProjectScope(p.id, tool, label);
    if (!ok) {
      process.stderr.write(
        `${tool}:${label} is not in "${p.name}" scope (nothing to do)\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`unscoped ${tool}:${label} from "${p.name}"\n`);
  } finally {
    store.close();
  }
}

function projectEnforceCmd(args: string[]): void {
  const [pathArg, mode] = args;
  if (!pathArg || (mode !== "on" && mode !== "off")) {
    process.stderr.write("usage: stm project enforce <path> <on|off>\n");
    process.exit(1);
  }
  const store = new Store();
  try {
    const p = store.getProjectByPath(pathArg);
    if (!p) {
      process.stderr.write(`no project at "${pathArg}"\n`);
      process.exit(1);
    }
    store.setEnforceScope(p.id, mode === "on");
    if (mode === "on") {
      const scope = store.projectScope(p.id);
      process.stdout.write(
        `enforcement ON for "${p.name}".\n` +
          `Out-of-scope placeholders will now be DENIED by PreToolUse.\n` +
          (scope.length === 0
            ? `  Scope is currently empty — every placeholder will be denied. Add some\n` +
              `  with: stm project scope ${p.path} <tool>:<label>\n`
            : `  ${scope.length} key${scope.length === 1 ? "" : "s"} in scope.\n`),
      );
    } else {
      process.stdout.write(
        `enforcement OFF for "${p.name}". Scope is now guidance only.\n`,
      );
    }
  } finally {
    store.close();
  }
}

function projectRenameCmd(args: string[]): void {
  const [pathArg, ...rest] = args;
  const newName = rest.join(" ").trim();
  if (!pathArg || !newName) {
    process.stderr.write("usage: stm project rename <path> <new-name>\n");
    process.exit(1);
  }
  const store = new Store();
  try {
    const p = store.getProjectByPath(pathArg);
    if (!p) {
      process.stderr.write(`no project at "${pathArg}"\n`);
      process.exit(1);
    }
    store.renameProject(p.id, newName);
    process.stdout.write(`renamed #${p.id} "${p.name}" → "${newName}"\n`);
  } finally {
    store.close();
  }
}

function projectRemoveCmd(args: string[]): void {
  const [pathArg] = args;
  if (!pathArg) {
    process.stderr.write("usage: stm project remove <path>\n");
    process.exit(1);
  }
  const store = new Store();
  try {
    const p = store.getProjectByPath(pathArg);
    if (!p) {
      process.stderr.write(`no project at "${pathArg}"\n`);
      process.exit(1);
    }
    store.removeProject(p.id);
    process.stdout.write(`removed project #${p.id} "${p.name}"\n`);
  } finally {
    store.close();
  }
}

async function projectCmd(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add":
      return projectAddCmd(rest);
    case "list":
    case "ls":
      return projectListCmd();
    case "show":
    case "view":
      return projectShowCmd(rest);
    case "scope":
      return projectScopeCmd(rest);
    case "unscope":
      return projectUnscopeCmd(rest);
    case "enforce":
      return projectEnforceCmd(rest);
    case "rename":
      return projectRenameCmd(rest);
    case "remove":
    case "rm":
    case "delete":
      return projectRemoveCmd(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return projectHelp();
    default:
      process.stderr.write(`stm project: unknown subcommand "${sub}"\n\n`);
      projectHelp();
      process.exit(1);
  }
}

// ---- audit ----------------------------------------------------------------

const AUDIT_EVENTS = new Set([
  "substitute",
  "policy.deny",
  "policy.warn",
  "unresolved",
  "malformed",
]);

function auditHelp(): void {
  process.stdout.write(
    `subscribetome — audit log of PreToolUse decisions\n\n` +
      `  stm audit                                 last 20 events (most recent first)\n` +
      `  stm audit --tail N                        last N (max 10000)\n` +
      `  stm audit --event <class>                 filter by event class:\n` +
      `                                            substitute | policy.deny | policy.warn\n` +
      `                                            | unresolved | malformed\n` +
      `  stm audit --tool <name>                   filter by tool, e.g. openai\n` +
      `  stm audit --since <duration>              5m, 1h, 7d\n` +
      `  stm audit prune --before <duration>       drop rows older than 7d, etc.\n` +
      `  stm audit prune --keep <N>                keep only the N most-recent rows\n` +
      `  stm audit clear                           remove every row (no undo)\n` +
      `\nThe log NEVER contains a real key value — placeholders only. See README\n` +
      `and specs/audit-log.md §5 for the load-bearing invariant.\n`,
  );
}

function fmtTs(iso: string): string {
  // 2026-05-21T04:25:09.123Z  ->  2026-05-21 04:25:09
  return iso.slice(0, 10) + " " + iso.slice(11, 19);
}

function auditListCmd(args: string[]): void {
  const { flags } = parseFlags(args);
  const tail = flags.tail ? Number(flags.tail) : 20;
  if (!Number.isFinite(tail) || tail <= 0) {
    process.stderr.write("error: --tail must be a positive number\n");
    process.exit(1);
  }
  const event = flags.event;
  if (event !== undefined && !AUDIT_EVENTS.has(event)) {
    process.stderr.write(
      `error: --event must be one of: ${[...AUDIT_EVENTS].join(", ")}\n`,
    );
    process.exit(1);
  }
  let sinceISO: string | undefined;
  if (flags.since) {
    const ms = parseDuration(flags.since);
    if (ms == null) {
      process.stderr.write(`error: --since "${flags.since}" — use forms like 5m, 1h, 7d\n`);
      process.exit(1);
    }
    sinceISO = new Date(Date.now() - ms).toISOString();
  }

  const store = new Store();
  try {
    const rows = store.listAudit({
      limit: tail,
      event: event as AuditEvent | undefined,
      tool: flags.tool,
      sinceISO,
    });
    if (rows.length === 0) {
      process.stdout.write("No audit rows.\n");
      return;
    }
    // chronological display: oldest first so a tail reads like a console log
    rows.reverse();
    printTable(
      ["TIME", "EVENT", "KEY", "INFO"],
      rows.map((r) => {
        const key =
          r.tool && r.label ? `${r.tool}:${r.label}` : r.tool ?? r.label ?? "—";
        const info = r.policy_id
          ? `rule #${r.policy_id}${r.reason ? `: ${r.reason}` : ""}`
          : r.reason ?? "";
        return [fmtTs(r.ts), r.event, key, info];
      }),
    );
    process.stdout.write(
      `\n  ${rows.length} row${rows.length === 1 ? "" : "s"} shown · ` +
        `${store.auditCount()} total in log\n\n`,
    );
  } finally {
    store.close();
  }
}

function auditPruneCmd(args: string[]): void {
  const { flags } = parseFlags(args);
  const hasBefore = flags.before != null && flags.before !== "true";
  const hasKeep = flags.keep != null && flags.keep !== "true";
  if (hasBefore === hasKeep) {
    process.stderr.write(
      "usage: stm audit prune --before <duration>  |  stm audit prune --keep <N>\n",
    );
    process.exit(1);
  }
  const store = new Store();
  try {
    let removed = 0;
    if (hasBefore) {
      const ms = parseDuration(flags.before);
      if (ms == null) {
        process.stderr.write(`error: --before "${flags.before}" — use forms like 5m, 1h, 7d\n`);
        process.exit(1);
      }
      const beforeISO = new Date(Date.now() - ms).toISOString();
      removed = store.pruneAudit({ beforeISO });
    } else {
      const n = Number(flags.keep);
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write("error: --keep must be a non-negative number\n");
        process.exit(1);
      }
      removed = store.pruneAudit({ keepNewest: n });
    }
    process.stdout.write(
      `pruned ${removed} row${removed === 1 ? "" : "s"} · ${store.auditCount()} remain\n`,
    );
  } finally {
    store.close();
  }
}

function auditClearCmd(args: string[]): void {
  const { flags } = parseFlags(args);
  if (!flags.yes && process.stdout.isTTY) {
    process.stderr.write(
      "stm audit clear deletes every row. Re-run with --yes to confirm:\n" +
        "  stm audit clear --yes\n",
    );
    process.exit(1);
  }
  const store = new Store();
  try {
    const removed = store.clearAudit();
    process.stdout.write(`cleared ${removed} row${removed === 1 ? "" : "s"}\n`);
  } finally {
    store.close();
  }
}

async function auditCmd(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "list":
    case "tail":
      return auditListCmd(args.slice(args[0] === "list" || args[0] === "tail" ? 1 : 0));
    case "prune":
      return auditPruneCmd(rest);
    case "clear":
      return auditClearCmd(rest);
    case "help":
    case "--help":
    case "-h":
      return auditHelp();
    default:
      // Treat unknown leading tokens as flags-on-`list`. So
      //   `stm audit --tail 5 --event substitute`
      // works without typing `list`.
      if (sub.startsWith("--")) return auditListCmd(args);
      process.stderr.write(`stm audit: unknown subcommand "${sub}"\n\n`);
      auditHelp();
      process.exit(1);
  }
}

// ---- sync (specs/spend-visibility.md) -------------------------------------

function syncHelp(): void {
  process.stdout.write(
    `subscribetome — spend sync (specs/spend-visibility.md)\n\n` +
      `  stm sync                          refresh every sync-enabled provider\n` +
      `  stm sync <provider>               refresh one provider (e.g. openai)\n` +
      `  stm sync --list                   list registered providers\n` +
      `\nstm makes outbound network calls ONLY when you run \`stm sync\`,\n` +
      `ONLY to the providers you have configured. No background activity,\n` +
      `no telemetry, no phone-home. Ever.\n` +
      `\nEach provider needs a separate admin-scoped credential (e.g. for\n` +
      `OpenAI, label \`admin-key\` against tool \`openai\`). Add one via the\n` +
      `dashboard's \"Enable sync\" toggle, then run \`stm sync\`.\n`,
  );
}

async function syncCmd(args: string[]): Promise<void> {
  const { flags, positional } = parseFlags(args);
  if (flags.help || flags.h || positional[0] === "help") {
    return syncHelp();
  }
  if (flags.list) {
    const ids = listProviderIds();
    if (!ids.length) {
      process.stdout.write("No providers registered.\n");
      return;
    }
    process.stdout.write("Registered providers:\n");
    for (const id of ids) process.stdout.write(`  ${id}\n`);
    return;
  }

  const target = positional[0];
  // Banner — the spec requires the network-posture rule to be visible
  // every time a sync runs (not just in help). Single line so it
  // doesn't drown out the results table.
  process.stdout.write(
    `stm sync — outbound calls only to the providers you've configured. ` +
      `No telemetry. No background activity.\n\n`,
  );

  if (target) {
    const r = await syncProvider(target);
    if (r == null) {
      process.stderr.write(
        `error: unknown provider "${target}". Known: ${listProviderIds().join(", ")}\n`,
      );
      process.exit(1);
    }
    printSyncResult(r);
    process.exit(r.ok ? 0 : 1);
  }
  const rows = await syncAll();
  if (rows.length === 0) {
    process.stdout.write("No providers registered.\n");
    return;
  }
  for (const r of rows) printSyncResult(r);
  // Exit non-zero only if EVERY provider failed; partial success is success.
  const anyOk = rows.some((r) => r.ok);
  process.exit(anyOk ? 0 : 1);
}

function printSyncResult(r: { tool: string; ok: boolean; usd?: number; at: string; error?: string; missingCredential?: boolean }): void {
  if (r.ok) {
    process.stdout.write(
      `  ${r.tool.padEnd(12)}  $${(r.usd ?? 0).toFixed(2).padStart(10)}` +
        `   ${r.at}\n`,
    );
  } else if (r.missingCredential) {
    process.stdout.write(
      `  ${r.tool.padEnd(12)}  (not configured — ${r.error})\n`,
    );
  } else {
    process.stdout.write(
      `  ${r.tool.padEnd(12)}  failed: ${r.error}\n`,
    );
  }
}

// ---- codex (specs/cross-platform-and-codex.md §6) -------------------------

function codexHelp(): void {
  process.stdout.write(
    `subscribetome — Codex (OpenAI Codex CLI) launcher\n\n` +
      `  stm codex [codex-args...]            launch codex with stm-managed keys\n` +
      `                                       injected as env vars\n` +
      `  stm codex --dry-run [codex-args...]  print the injection plan and the\n` +
      `                                       exact argv codex would receive,\n` +
      `                                       then exit without launching\n` +
      `\nWhat this does (and why it is weaker than Claude Code):\n` +
      `\n` +
      `  stm resolves your active keys and exposes each as an environment\n` +
      `  variable named STM_<TOOL>_<LABEL>. codex inherits those vars and\n` +
      `  its agent shells can read them (e.g. \`curl ... -H "Authorization:\n` +
      `  Bearer $STM_OPENAI_DEFAULT"\`). Real values appear nowhere in argv,\n` +
      `  nowhere in any config file we write.\n` +
      `\n` +
      `  The TRADE-OFF (spec §6, Option 1): the value lives in codex's\n` +
      `  process environment for the whole session, not substituted per\n` +
      `  command. A command that dumps its environment can surface it.\n` +
      `  Claude Code's PreToolUse rewrite is strictly stronger; Codex does\n` +
      `  not yet support that mode (openai/codex#18491).\n` +
      `\n` +
      `If the cwd matches a registered project (\`stm project list\`), only\n` +
      `that project's scoped keys are injected. Otherwise ALL active keys\n` +
      `are injected.\n`,
  );
}

async function codexCmd(args: string[]): Promise<void> {
  // We deliberately do NOT use parseFlags here — codex has its own CLI
  // and the user's args go through untouched. The only stm-side flag we
  // intercept is `--dry-run` (must be the first token) and `--help`.
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    return codexHelp();
  }
  let dryRun = false;
  if (args[0] === "--dry-run") {
    dryRun = true;
    args = args.slice(1);
  }

  const store = new Store();
  try {
    const plan = buildInjectionPlan({ store, cwd: process.cwd() });
    if (plan.collisions.length > 0) {
      process.stderr.write(
        `stm codex: refusing to launch — env var name collisions detected.\n` +
          `Two or more (tool, label) pairs map to the same STM_* variable, and\n` +
          `silently overwriting one secret with another is exactly the failure\n` +
          `mode the spec warns against.\n\n`,
      );
      for (const c of plan.collisions) {
        process.stderr.write(`  ${c.envName} ← ${c.tools.join(", ")}\n`);
      }
      process.stderr.write(
        `\nRename one side via \`stm revoke\` + re-add with a different label.\n`,
      );
      process.exit(1);
    }

    process.stderr.write("\n" + launchBanner(plan) + "\n");

    if (dryRun) {
      process.stdout.write(
        `(dry run — codex was NOT launched. Drop --dry-run to launch.)\n`,
      );
      return;
    }

    let values: Record<string, string>;
    try {
      values = resolveInjectionValues({ store, plan });
    } catch (e: any) {
      process.stderr.write(`stm codex: ${e?.message ?? e}\n`);
      process.exit(1);
    }

    let result;
    try {
      result = await launchCodex({ values, userArgs: args });
    } catch (e: any) {
      process.stderr.write(`stm codex: ${e?.message ?? e}\n`);
      process.exit(1);
    }
    // Propagate codex's exit code so `stm codex` is transparent to shell
    // pipelines and CI gates. Signal-terminated children exit non-zero.
    if (result.signal) {
      process.stderr.write(`codex terminated by signal ${result.signal}\n`);
      process.exit(1);
    }
    process.exit(result.code ?? 0);
  } finally {
    store.close();
  }
}

async function policyCmd(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
    case "ls":
      return policyListCmd();
    case "add":
      return policyAddCmd(rest);
    case "remove":
    case "rm":
    case "delete":
      return policyRemoveCmd(rest);
    case "test":
    case "check":
      return policyTestCmd(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return policyHelp();
    default:
      process.stderr.write(`stm policy: unknown subcommand "${sub}"\n\n`);
      policyHelp();
      process.exit(1);
  }
}

function revokeCmd(args: string[]): void {
  if (args.length < 2) {
    process.stderr.write("usage: stm revoke <tool> <label>\n");
    process.exit(1);
  }
  const store = new Store();
  try {
    const ok = store.revokeKey(args[0], args[1]);
    if (ok) {
      process.stdout.write(`revoked ${args[0]}:${args[1]}\n`);
    } else {
      process.stderr.write(`no such key: ${args[0]}:${args[1]}\n`);
      process.exit(1);
    }
  } finally {
    store.close();
  }
}

function helpCmd(): void {
  process.stdout.write(
    `subscribetome — AI API key & subscription manager\n\n` +
      `  stm add --tool <name> [--label <l>] [--plan <p>] [--cost <usd>]\n` +
      `                                  add a key (value read from stdin)\n` +
      `  stm list                        show keys, subscriptions, monthly spend\n` +
      `  stm resolve {{stm:t:l}}          print a key value (local use only)\n` +
      `  stm revoke <tool> <label>       mark a key revoked\n` +
      `  stm policy <list|add|remove|test>  allow/deny rules at PreToolUse\n` +
      `  stm audit [--tail N] [--event] [--tool] [--since]  PreToolUse decision log\n` +
      `  stm sync [provider]             fetch real spend from configured providers\n` +
      `  stm codex [codex-args...]       launch Codex with stm-managed keys (session-env mode)\n` +
      `  stm project <add|list|show|scope|unscope|enforce|rename|remove>  per-project key scope\n` +
      `  stm import [dir...]             scan .env files for importable keys\n` +
      `  stm dashboard                   open the localhost web dashboard\n` +
      `  stm stop                        stop the dashboard daemon\n` +
      `  stm status                      daemon + inventory summary\n`,
  );
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "hook": {
      switch (rest[0]) {
        case "pretooluse":
          return preToolUse();
        case "posttooluse":
          return postToolUse();
        case "userpromptsubmit":
          return userPromptSubmit();
        case "sessionstart":
          return sessionStart();
        default:
          process.exit(0); // unknown hook — no-op, fail safe
      }
    }
    case "add":
      return addCmd(rest);
    case "list":
    case "ls":
      return listCmd();
    case "resolve":
      return resolveCmd(rest);
    case "revoke":
      return revokeCmd(rest);
    case "policy":
      return policyCmd(rest);
    case "audit":
      return auditCmd(rest);
    case "sync":
      return syncCmd(rest);
    case "codex":
      return codexCmd(rest);
    case "project":
      return projectCmd(rest);
    case "import": {
      const imp = await import("./import.ts");
      return imp.runImport(rest);
    }
    case "dashboard":
    case "open": {
      const d = await import("./daemon.ts");
      return d.openDashboard();
    }
    case "daemon": {
      const d = await import("./daemon.ts");
      return d.runDaemon();
    }
    case "stop": {
      const d = await import("./daemon.ts");
      return d.stopDaemon();
    }
    case "status": {
      const d = await import("./daemon.ts");
      return d.printStatus();
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return helpCmd();
    default:
      process.stderr.write(`stm: unknown command "${cmd}"\n\n`);
      helpCmd();
      process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`stm: ${e?.message ?? e}\n`);
  process.exit(1);
});
