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
//   stm hook <pretooluse|posttooluse|userpromptsubmit>     (called by hooks)
import { Store } from "./store.ts";
import { preToolUse, postToolUse, userPromptSubmit } from "./hooks.ts";

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
