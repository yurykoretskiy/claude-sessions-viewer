# Claude Sessions

VS Code extension. Every Claude Code session on your machine, organized by
project folder, one click away.

## What it does

- **Sessions by folder** — activity-bar tree of all local Claude Code
  sessions: title, session id, age, your prompts inside each session.
- **Smart attribution** — sessions started at the workspace root are filed
  under the folder they actually worked in (marked `≈`). Toggle to Claude's
  raw index anytime; the title bar always shows the active mode.
- **Search** — 🔍 in the view title: fuzzy match across titles, prompts,
  folders, ids. Enter resumes the session.
- **Launchers** — right-click any folder: *New session here* (terminal) or
  *New window session here* (official Claude panel, new window).
- **Resume is explicit** — click previews (expands prompts); the ▶ button
  or context menu resumes in a terminal at the correct directory.
- **Rename** — give untitled sessions a custom name (stored locally).

## Install

```bash
./build-vsix.sh --install   # requires the `code` CLI; then reload the window
```

Or install a prebuilt `claude-sessions-viewer-<version>.vsix`:
`code --install-extension claude-sessions-viewer-<version>.vsix`

## Requirements

macOS/Linux, VS Code ≥ 1.85, Claude Code CLI (`claude`) on PATH,
sessions in `~/.claude/projects` (the default).

## Share

Send the folder (or the `.vsix` alone). Receiver runs the install command
above. No marketplace, no account, no telemetry — everything stays local.

*Docs for AI agents working on this repo: see [AGENTS.md](AGENTS.md).
Deferred ideas: [BACKLOG.md](BACKLOG.md).*
