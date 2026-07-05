# AGENTS.md — how to work on / apply this extension

Instructions for AI agents (Claude Code, Codex, etc.) operating on this repo.

## What this is

Local VS Code extension `yury.claude-sessions`. Renders all Claude Code
sessions from `~/.claude/projects/*/*.jsonl` as a tree grouped by project
folder, with launch/resume/search/rename commands. No build toolchain, no
dependencies, plain JavaScript — do not introduce TypeScript, bundlers, or
npm packages.

## Files

| File | Role |
| --- | --- |
| `extension.js` | Activation, `SessionTreeProvider` (tree: folder → session → prompts), all commands, fs watcher, new-window flag handshake |
| `indexer.js` | Streaming parser of session `.jsonl` files → `{id, title, cwd, lastTs, prompts, folderMentions}`; mtime+size cache keyed per file |
| `package.json` | Manifest: view container, commands, context/title menus |
| `build-vsix.sh` | Packages a `.vsix` by hand (zip + manifest, no vsce) and optionally installs via `code --install-extension` |
| `poc/` | Throwaway HTML mockups shown to Yury before building |

## How to apply (install / deploy)

```bash
./build-vsix.sh --install     # build + install
# then the user reloads the VS Code window (Developer: Reload Window)
```

Verify with `code --list-extensions --show-versions | grep yury`.

## Rules when modifying

1. **Bump `version` in `package.json`** on every install-worthy change —
   VS Code caches by version; same-version reinstalls may not refresh.
2. **Bump `INDEX_VERSION` in `indexer.js`** whenever the extracted session
   shape changes — this invalidates the per-file cache.
3. Session clicks must stay **passive** (preview/expand only). Resume,
   delete, or anything that runs a process must be an explicit button or
   menu action (owner's requirement).
4. Session/prompt labels are padded with ` ` em-spaces — VS Code has
   no per-item indent API; do not "clean up" this padding.
5. Attribution logic lives in `attributeSession()`; the content threshold
   is `MIN_MENTIONS`. Prefer tuning over rewriting.
6. Commit prefix `[cc]` (Claude) or `[gpt]` (Codex); never commit `.vsix`
   artifacts (gitignored).
7. Test the indexer headlessly before packaging:
   `node -e 'require("./indexer").indexAll("/tmp/cache.json").then(s => console.log(s.length))'`

## Data source facts (verified 05 Jul 2026)

- One `.jsonl` per session, top level of each `~/.claude/projects/<dir>/`.
- Deeper `.jsonl` files are subagent sidechains — exclude them.
- `aiTitle` lines can appear anywhere in the file; some sessions have none
  (fallback: first user prompt).
- `cwd` in the transcript is ground truth for where a session started; the
  project directory name encoding is ambiguous (dashes) — never decode it.
- Transcripts are auto-deleted after `cleanupPeriodDays` (owner set: 365).
  `~/.claude/history.jsonl` retains prompts of purged sessions.
