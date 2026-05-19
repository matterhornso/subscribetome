# Contributing to subscribetome

Thanks for helping. subscribetome is a small, focused tool — contributions that
keep it small and focused are the most welcome.

## Setup

Requires macOS, [Bun](https://bun.sh), and [Claude Code](https://claude.com/claude-code).

```
git clone https://github.com/matterhornso/subscribetome
cd subscribetome
bun test               # run the suite — should be all green before you start
bun src/cli.ts <args>  # run the CLI from source
```

Runtime state lives in `~/.subscribetome/`. The test suite isolates itself with
`$STM_DB` and `$STM_KEYCHAIN_SERVICE` — never point those at real state.

## The one rule

**A real key value must never reach the Claude Code transcript, a log, or
stdout.** Before submitting, check that your change cannot print, log, or
return a resolved key. Hooks must fail safe: on any error, substitute nothing
and exit 0 — never bubble a key out through an error message.

## Adding a service to the catalog

This is the most common contribution and it's a data-only change. Edit
`src/catalog.ts` and append a `ServiceDef`:

```ts
{ id: "linear", name: "Linear", credentials: ["api-key"] },
```

- `id` — the tool name; lowercase `[a-z0-9-]`, 1-64 chars. It becomes the
  `<tool>` in `{{stm:<tool>:<label>}}`.
- `name` — the human-readable name shown in the dashboard picker.
- `credentials` — the labels for the credentials that service issues. Use the
  service's **own terminology**, normalized to lowercase-hyphen (e.g.
  `account-sid`, `secret-key`, `webhook-secret`). Verify against the service's
  real docs — accuracy matters more than guessing.

`test/catalog.test.ts` validates every entry; run `bun test` after editing.

## Tests

Every behaviour change needs a test. The suite (`bun test`) covers grammar,
key-shape detection, the store, the hooks, `.env` import, and the catalog. New
hooks or store methods must have a test that proves the security property they
exist for.

## Commits & pull requests

- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`,
  `perf:`. Imperative mood, lowercase subject.
- One logical change per PR. Keep the diff readable.
- Bumping a release: update the version in `plugin.json`, `marketplace.json`,
  and `package.json` together, and add a `CHANGELOG.md` entry.

## Scope

v1 is intentionally macOS + Claude Code only. Larger directions — Linux/Windows
keychain backends, other coding agents, provider-side rotation — are tracked in
[`TODOS.md`](./TODOS.md). If you want to take one on, open an issue first so we
can agree on the shape before you write code.

## Security issues

Do not open a public issue or PR for a vulnerability. See [`SECURITY.md`](./SECURITY.md).
