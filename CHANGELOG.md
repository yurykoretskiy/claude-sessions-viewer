# Changelog

All notable changes to this extension. Format follows
[Keep a Changelog](https://keepachangelog.com); versions follow
[SemVer](https://semver.org). Each release is tagged and published with an
installable `.vsix` on the
[Releases page](https://github.com/yurykoretskiy/claude-sessions-viewer/releases).

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
