# Claude Sessions Viewer

**Every Claude Code session on your machine — organized by project folder,
readable like a chat, one click away. A VS Code extension.**

![Claude Sessions Viewer](assets/screenshots/hero-dark.png)

Claude Code stores every conversation on disk, but gives you no way to see
them across projects — sessions pile up, get misfiled under the workspace
root, and auto-delete after 30 days. This extension turns that hidden pile
into a browsable map.

## Features

- **Sessions by folder** — activity-bar tree of all local sessions: title,
  id, age. Folders sorted by recent activity.
- **Smart attribution** — sessions started at the workspace root are
  re-filed under the folder they actually worked in (marked `≈`), by
  analyzing which paths the session touched. Toggle to Claude's raw index
  anytime.
- **Conversation viewer** — click a session and read it like a chat: your
  messages right, Claude's left, tool noise hidden (optional markers),
  opens at the last message. Read-only — nothing runs on click.
- **Filters & modes** — All / you / Claude; chat bubbles or plain
  copy-clean flow; names on/off for sharing; one-click copy of the entire
  conversation; export to Markdown (drop straight into an Obsidian vault).
- **Launchers** — right-click any folder in the Explorer: *New session
  here* (terminal) or *New window session here* (official Claude Code
  panel). Resume any session in a terminal at its original directory.
- **Reveal current session** — a ✳ button on the Claude Code panel tab (and
  in the status bar) locates the session you're working in right now:
  highlights it in the tree and opens its conversation beside you, updating
  live as the session continues.
- **Search** — fuzzy match across titles, prompts, folders, ids.
- **Rename** — give untitled sessions a custom name (stored locally).

| Light theme | Copy-clean plain flow | Filter: your messages |
| --- | --- | --- |
| ![Light](assets/screenshots/viewer-light.png) | ![Plain](assets/screenshots/plain-mode.png) | ![Filter](assets/screenshots/filter-user.png) |

## Install

Grab the `.vsix` from [Releases](https://github.com/yurykoretskiy/claude-sessions-viewer/releases), then:

```bash
code --install-extension claude-sessions-viewer-1.3.0.vsix
```

Reload the window. A ✳ icon appears in the activity bar.

Or build from source (no toolchain needed — plain JavaScript):

```bash
git clone https://github.com/yurykoretskiy/claude-sessions-viewer
cd claude-sessions-viewer && ./build-vsix.sh --install
```

## First run

On activation the extension indexes `~/.claude/projects` (your existing
Claude Code sessions — nothing to configure). Indexing streams each
transcript once and caches results, so the first load takes a few seconds
per few hundred sessions and is instant afterwards; only changed files are
re-read. The tree refreshes itself when sessions change, or hit ⟳.
Conversations are parsed lazily — only when you open one.

## Privacy & how it works

Everything is local. The extension reads Claude Code's own session files
(`~/.claude/projects/*/*.jsonl`), writes nothing to them, and makes no
network requests of any kind. No telemetry.

Tip: Claude Code deletes transcripts after 30 days by default. Add
`"cleanupPeriodDays": 365` to `~/.claude/settings.json` to keep a year.

## Requirements

- VS Code ≥ 1.85
- [Claude Code](https://claude.com/claude-code) CLI (`claude`) on PATH —
  only needed for the resume/new-session buttons; browsing works without it
- macOS/Linux

## For AI agents

Working on this repo with Claude Code, Codex, or similar? Read
[AGENTS.md](AGENTS.md) — file map, build/deploy contract, and the invariants
that must not be broken. Deferred ideas live in [BACKLOG.md](BACKLOG.md);
maintainer's working notes in `docs/`, `findings/`, `inputs/`, `handoffs/`.

## License

[MIT](LICENSE)
