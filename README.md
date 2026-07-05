# Claude Sessions — VS Code extension

Codex-style sidebar for Claude Code: browse all sessions grouped by project
folder, resume any session with one click, and start new sessions from the
Explorer context menu. Built by Claude Code (`#claude`).

## Features

- **Sidebar tree** (activity bar → "Claude Sessions"): top level = your
  project folders, inside = sessions with AI title and age, newest first.
- **Smart folder attribution**: sessions started inside a subfolder are filed
  there; sessions started at the workspace root are attributed to the
  subfolder they actually worked in (dominant path mentions in the
  transcript, marked with `≈`); the rest land in `root (unassigned)`.
  Sessions started outside the workspace show under their `~/...` path.
- **Click a session → resumes it** in an integrated terminal cwd'd to the
  session's original directory (`claude --resume <id>`).
- **Right-click any folder in the Explorer → "Claude: New session here"** —
  opens a terminal in that folder and runs `claude`. Also available on
  folder rows in the tree (+ icon).
- Session context menu: open raw transcript `.jsonl`, copy session id.
- Auto-refreshes when `~/.claude/projects` changes (5s debounce); manual
  refresh button in the view title.

## Install / update

```bash
./build-vsix.sh --install   # builds .vsix (no vsce needed) and installs via `code` CLI
```

Then reload the VS Code window.

## How it works

`indexer.js` streams every `~/.claude/projects/*/**.jsonl` once, extracting
`aiTitle`, `cwd`, last timestamp, first/last prompt, and counts of
`<cwd>/<subfolder>/` path mentions. Results are cached in the extension's
global storage keyed by file mtime+size, so after the first index only
changed files are re-read.
