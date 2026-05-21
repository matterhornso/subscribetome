# Awesome-list PRs

Backlinks from awesome-lists are some of the most durable in the
ecosystem — they live forever on a high-domain page and they get cited
in AI search ("best Claude Code plugins"). Here's the exact text and
ordering to land subscribetome on the three most-trafficked lists.

## 1. ComposioHQ / awesome-claude-plugins (highest priority)

**Why first:** active, well-structured, has a clean *Documentation &
Security* section that fits stm exactly, and uses inline entries with
external URLs (perfect for a third-party submission).

**Repo:** https://github.com/ComposioHQ/awesome-claude-plugins
**File to edit:** `README.md`
**Section:** `### Documentation & Security`

**Insertion — add as the last entry in that section:**

```markdown
- [subscribetome (stm)](https://github.com/matterhornso/subscribetome) - Open-source API key manager for Claude Code. Every key lives in the macOS Keychain; a PreToolUse hook substitutes the real value into shell commands the instant before they run, so the chat transcript never holds one. 36 services pre-configured, MIT.
```

**PR commit message:**

```
Add subscribetome to Documentation & Security

An open-source Claude Code plugin from Matterhorn Labs that keeps API
keys out of the chat transcript: keys live in the macOS Keychain, and
a PreToolUse hook substitutes the real value into each shell command
the instant before it runs.

- Source: https://github.com/matterhornso/subscribetome
- Site:   https://subscribetome.pro
- MIT licensed, zero runtime dependencies, no backend.
```

**One-shot fork-and-PR via gh:**

```bash
gh repo fork ComposioHQ/awesome-claude-plugins --clone
cd awesome-claude-plugins
# add the line above into the Documentation & Security section of README.md
git checkout -b add-subscribetome
git add README.md
git commit -m "Add subscribetome to Documentation & Security"
git push origin add-subscribetome
gh pr create \
  --title "Add subscribetome to Documentation & Security" \
  --body "Open-source Claude Code plugin that keeps API keys out of the chat transcript. Keys live in the macOS Keychain; a PreToolUse hook substitutes the real value into shell commands the instant before they run. 36 services pre-configured, MIT licensed, no backend. Source: https://github.com/matterhornso/subscribetome · Site: https://subscribetome.pro"
```

## 2. hesreallyhim / awesome-claude-code (highest stars — 44k+)

**Why second, not first:** the list is mid-restructure (README is
mostly a "TODO" placeholder right now). Submitting before the new
structure lands risks the PR sitting unmerged for weeks. Watch the
repo; when the table of contents is filled in, submit then.

**Repo:** https://github.com/hesreallyhim/awesome-claude-code
**Action:** **WAIT** — open an issue first asking which section a
secrets/API-key plugin belongs in, then submit when the structure
lands.

When ready, use the same entry text as #1 above. Drop the
"(stm)" parenthetical if the list uses single-word entries.

## 3. ccplugins / awesome-claude-code-plugins

**Why third:** structure is folder-based (each plugin gets its own
folder, not an inline entry). Submissions are heavier — you'd need to
either fork their repo and copy the plugin in, or just link to ours.

**Repo:** https://github.com/ccplugins/awesome-claude-code-plugins
**Section:** Most likely *Plugins* or a new *Security & Secrets*
subsection.

**Action:** Open an issue first asking how third-party plugins are
listed (link vs include). Submit per their guidance. Lower priority
than #1.

## What to do RIGHT NOW

Run the one-shot block from §1. That single PR is the highest-leverage
backlink available before launch. Watching #2 is a one-minute task —
just star the repo so updates show up in your feed.

## After the PR is merged

- Add the awesome-list badge to the project README:

  ```markdown
  [![Awesome Claude Code Plugins](https://awesome.re/mentioned-badge.svg)](https://github.com/ComposioHQ/awesome-claude-plugins#documentation--security)
  ```

- Re-ping IndexNow with the updated README URL so Bing re-crawls.

- Add a one-liner to the launch tweet thread (replied tweet, after the
  initial seven) thanking the list maintainer and linking the entry.
