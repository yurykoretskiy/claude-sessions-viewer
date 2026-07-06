# Changelog

All notable changes to this extension. Format follows
[Keep a Changelog](https://keepachangelog.com); versions follow
[SemVer](https://semver.org). Each release is tagged and published with an
installable `.vsix` on the
[Releases page](https://github.com/yurykoretskiy/claude-sessions-viewer/releases).

## [1.4.5] — 2026-07-06

### Fixed
- Packaged README screenshots, changelog, and license into the `.vsix` so the
  installed extension documentation matches the GitHub README.

### Changed
- README now describes the current review-first behavior only: tree reveal,
  optional review pane, review-opening search, and explicit resume inside the
  review pane.

## [1.4.4] — 2026-07-06

### Added
- First-run prompt explains reveal/review behavior and lets the user choose
  "Open Review Pane", "Tree Only", or Settings. The choice is stored in VS
  Code global settings.
- The tree now shows an immediate "Indexing Claude sessions..." row during
  cold first-run indexing instead of appearing blank.

### Changed
- `claudeSessionsViewer.reveal.openConversation` defaults to on for new users
  so reveal demonstrates the read-only review pane. Constant users can switch
  it off for tree-only reveal.
- Tree search opens the read-only review pane instead of resuming the session.
  Resume remains inside the viewer.
- Grouping UI now says "working folders" and "Claude raw storage" instead of
  "smart" and "raw", with a short status message when toggled.

## [1.4.3] — 2026-07-06

### Fixed
- Reveal now matches the active Claude tab against session title, first prompt,
  and last prompt, including truncated tab titles, instead of falling back too
  easily to the first active transcript.

### Changed
- Reveal is tree-first by default. It selects the session row in the tree and
  no longer opens the full conversation unless
  `claudeSessionsViewer.reveal.openConversation` is switched on.
- The activity/status reveal tooltip now describes the tree-pointing behavior.

## [1.4.2] — 2026-07-06

### Fixed
- Reveal no longer stops on the "several sessions are active" picker. It now
  prefers the active Claude tab title and otherwise reveals the newest active
  transcript.

### Changed
- Session rows in the tree are review-only: the resume/play action was removed
  from tree inline/context menus and remains inside the conversation viewer.
- Project folders default collapsed so first load does not render every
  session row across every project at once.
- The conversation viewer resume button now uses the Claude accent treatment
  to make the one run/resume surface visually clear.

## [1.4.1] — 2026-07-06

### Fixed
- Reveal now selects the session row in the tree instead of passing a wrapper
  object that VS Code cannot reliably reveal.

### Changed
- Tree browsing is session-level by default: prompt/message child rows are
  hidden unless `claudeSessionsViewer.promptChildren.enabled` is switched on.
- Session-level indexing skips storing prompt child rows when prompt children
  are off, reducing first-load/cache work.
- Live conversation refresh is now optional and off by default via
  `claudeSessionsViewer.liveRefresh.enabled`.
- Reveal controls can be switched off with
  `claudeSessionsViewer.reveal.enabled`; reveal can also be configured to
  select the tree row without opening the viewer.

## [1.4.0] — 2026-07-06

### Added
- **Reveal current session**: ✳ button on the official Claude Code panel tab
  (`activeWebviewPanelId == claudeVSCodePanel`) and in the status bar —
  highlights the running session in the tree and opens its conversation
  split-beside. Quick pick when several sessions are active.
- Conversation viewer **live refresh**: re-extracts while the transcript
  grows (3 s poll); sticks to the last message, preserves scroll when
  reading history.
- **● live markers** in the tree for sessions active in the last 5 minutes.
- Tree `getParent` support (required for programmatic reveal).

## [1.3.0] — 2026-07-06

### Added
- **Conversation viewer** (read-only webview): chat layout (you right,
  Claude left), day separators, opens at last message; filters
  All / you / Claude; plain copy-clean flow; names on/off; tool markers
  off by default; copy-all, Markdown export, reveal raw `.jsonl`, resume
  button; themes System/Light/Dark; configurable user label.
- Conversation extractor ported from the legacy snapshot tool
  (`legacy-snapshot-viewer` branch): tool calls collapsed to one-line
  markers, thinking/base64/sidechains dropped. Verified: 161/161 transcripts
  parse, ≤203 ms for a 49 MB session.
- Custom spark folder icons (normal / root-unassigned / outside-workspace).
- Clicking a session now opens the viewer (still runs nothing).

### Fixed
- `build-vsix.sh` now packages all JS modules and SVG assets.

## [1.2.0] — 2026-07-06

### Changed
- Renamed `claude-sessions` → **claude-sessions-viewer** (extension id,
  repo, artifacts). Old GitHub URL redirects.

## [1.1.1] — 2026-07-06

### Fixed
- Sessions resumed from another directory were listed twice (transcript is
  copied into the second project dir) — deduped by freshest copy.
- Tree flicker: stable item ids; watcher debounce 5 s → 20 s.

## [1.1.0] — 2026-07-05

### Added
- Session **search** (fuzzy across titles/prompts/folders/ids), **rename**
  (local custom titles), prompts preview inside each session, visible
  session ids, em-space indent for session rows.

### Changed
- Clicking a session became passive (no resume on click) — resume moved to
  explicit ▶ / context menu.

## [1.0.0] — 2026-07-05

First stable release: sessions tree grouped by folder with smart
re-attribution of root-started sessions (`≈`), smart↔raw grouping toggle
with visible mode, right-click launchers (terminal session in any folder;
new-window session with auto-opened official panel), resume in terminal at
the session's original cwd, mtime-cached streaming indexer.
