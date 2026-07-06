# Claude Sessions Viewer

**Every Claude Code session on your machine — organized by project folder,
readable like a chat, one click away. A VS Code extension.**

![Claude Sessions Viewer](https://raw.githubusercontent.com/yurykoretskiy/claude-sessions-viewer/master/assets/screenshots/hero-dark.png)

Claude Code stores every conversation on disk, but gives you no way to see
them across projects — sessions pile up, get misfiled under the workspace
root, and auto-delete after 30 days. This extension turns that hidden pile
into a browsable map.

## Features

- **Sessions by folder** — activity-bar tree of all local sessions: title,
  id, age. Folders sorted by recent activity.
- **Working-folder grouping** — sessions are grouped by the real folder they
  ran in (the transcript's recorded `cwd`): your current project's sessions
  under the project name, everything else under its own path. Toggle to
  Claude's raw storage anytime.
- **Conversation viewer** — click a session and read it like a chat: your
  messages right, Claude's left, tool noise hidden (optional markers),
  opens at the last message. Read-only until you press the accent resume
  button in the viewer.
- **Filters & modes** — All / you / Claude; chat bubbles or plain
  copy-clean flow; names on/off for sharing; one-click copy of the entire
  conversation; export to Markdown (drop straight into an Obsidian vault).
- **Launchers** — right-click any folder in the Explorer: *New session
  here* (terminal) or *New window session here* (official Claude Code
  panel). Resume stays explicit inside the review pane.
- **Reveal current session** — a ✳ button on the Claude Code panel tab (and
  in the status bar) locates the session you're working in right now:
  highlights it in the tree. New users can also open the conversation review
  pane automatically; constant users can switch that off.
- **Search** — fuzzy match across titles, prompts, folders, ids; opens the
  read-only review pane.
- **Rename** — give untitled sessions a custom name (stored locally).
- **Session-level first** — the tree defaults to collapsed folders and
  folder → session browsing. Prompt rows under sessions can be switched on in
  settings when needed.

**Reveal the session you're in right now** — ✳ on the panel tab → highlighted in the tree:

![Reveal current session](https://raw.githubusercontent.com/yurykoretskiy/claude-sessions-viewer/master/assets/screenshots/reveal-current.png)

| Light theme | Copy-clean plain flow | Filter: your messages |
| --- | --- | --- |
| ![Light](https://raw.githubusercontent.com/yurykoretskiy/claude-sessions-viewer/master/assets/screenshots/viewer-light.png) | ![Plain](https://raw.githubusercontent.com/yurykoretskiy/claude-sessions-viewer/master/assets/screenshots/plain-mode.png) | ![Filter](https://raw.githubusercontent.com/yurykoretskiy/claude-sessions-viewer/master/assets/screenshots/filter-user.png) |

## How it works

- **Where sessions come from.** Claude Code writes every conversation to a
  transcript file under `~/.claude/projects/`. The extension reads those
  files — it never runs Claude, never phones home, and needs no configuration.
- **How grouping works.** Each transcript records the folder the session was
  started in. Sessions are grouped by that folder, newest first inside each
  group. The project you currently have open is pinned to the top with its
  own icon. A folder marked `gone` no longer exists on disk — its sessions
  are kept as browsable history.
- **When the list updates.** There is no background watcher. The tree
  re-indexes when the panel is opened or becomes visible again, when you
  press the ↻ refresh button, and when you press reveal (✳). So a session
  started in a new folder shows up the next time any of those happen.
  Re-indexing is cheap: only changed transcripts are re-read.
- **Conversations are always fresh.** Opening a session reads its transcript
  from disk at that moment, and the review pane live-updates while the
  session keeps writing.

## Install

Grab the `.vsix` from [Releases](https://github.com/yurykoretskiy/claude-sessions-viewer/releases), then:

```bash
code --install-extension claude-sessions-viewer-<version>.vsix
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
Conversations are parsed lazily — only when you open one. On a cold first
run, the tree shows an indexing row immediately instead of staying blank.
Prompt/message preview rows under sessions are off by default for faster
session-level browsing.

## Settings

- `claudeSessionsViewer.reveal.enabled` — show/enable reveal controls.
- `claudeSessionsViewer.reveal.openConversation` — reveal also opens the
  read-only conversation viewer. On by default for new users; switch it off
  for tree-only reveal.
- `claudeSessionsViewer.liveRefresh.enabled` — keep an opened viewer updated
  while the transcript changes. Off by default.
- `claudeSessionsViewer.promptChildren.enabled` — show prompt/message rows
  under sessions. Off by default.

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

## Changelog

Version history in [CHANGELOG.md](CHANGELOG.md); every release ships an
installable `.vsix` on the [Releases page](https://github.com/yurykoretskiy/claude-sessions-viewer/releases).

## License

[MIT](LICENSE)
