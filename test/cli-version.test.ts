// `stm --version` smoke test.
//
// v0.7.3 added the universal CLI version flag. We read the version
// from package.json at import time so the manifest is the single
// source of truth; this test asserts that:
//   1. The three accepted spellings (--version / -v / version) all
//      print the same string.
//   2. The reported version matches package.json verbatim — drift
//      between `stm --version` and the published plugin manifest
//      is exactly what this routing was built to prevent.

import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

const CLI = resolve(import.meta.dir, "..", "src", "cli.ts");

function run(arg: string): string {
  return execFileSync("bun", [CLI, arg], { encoding: "utf-8" }).trim();
}

test("--version reports the package.json version", () => {
  const expected = `stm ${(pkg as { version: string }).version}`;
  expect(run("--version")).toBe(expected);
});

test("-v reports the same version", () => {
  expect(run("-v")).toBe(run("--version"));
});

test("`version` subcommand reports the same version", () => {
  expect(run("version")).toBe(run("--version"));
});

test("the reported version matches plugin.json and marketplace.json", () => {
  // Drift prevention — if someone bumps package.json without bumping
  // the plugin manifests (or vice versa), this test fails fast.
  const plugin = require("../.claude-plugin/plugin.json") as { version: string };
  const marketplace = require("../.claude-plugin/marketplace.json") as {
    plugins: Array<{ version: string }>;
  };
  expect(plugin.version).toBe((pkg as { version: string }).version);
  expect(marketplace.plugins[0]?.version).toBe((pkg as { version: string }).version);
});
