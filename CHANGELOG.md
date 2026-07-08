# Changelog

All notable changes to this extension. Format follows
[Keep a Changelog](https://keepachangelog.com); versions follow
[SemVer](https://semver.org). Each release is tagged and published with an
installable `.vsix` on the
[Releases page](https://github.com/yurykoretskiy/claude-sessions-viewer/releases).

## [1.9.0] — 2026-07-08

### Changed
- **The tree now shows your sessions, not every file on disk.** Transcripts
  created by SDK automation (`/security-review` runs, background agents —
  entrypoint `sdk-py`/`sdk-cli`) are hidden by default, matching what the
  official Claude Code panel lists (in this repo: 4 sessions instead of 29;
  across the whole store: 81 instead of 213). Old transcripts without an
  entrypoint field always stay visible. New setting **Sessions Tree → Show
  Automation Sessions** brings them back.
- Packaging switched to the official `vsce` tool — the extension details
  page now gets the full manifest (version, icon, README/changelog assets).

## [1.8.9] — 2026-07-07

### Changed
- **The sort toggle now changes order, never structure.** "Recent activity"
  mode shows the same tree as Folders A-Z — one row per folder, sessions
  newest-first inside — re-ordered so the folder with the newest activity is
  on top (folder rows show `[age]` of their newest session). The previous
  timeline model repeated a busy folder dozens of times. Group ids are
  identical in both modes, so folder expansion survives toggling. Invariants
  (no duplicate folder rows, live sessions lift their folder to the top,
  path-based ids) are pinned by tests.
- **The live `●` moved to the left**, into the padding slot before `[age]` —
  the right-hand column is the first thing a narrow sidebar clips. Session
  rows no longer use the description column at all.
- Toggle button tooltips are action-first ("Switch to …") instead of
  describing the current state.

## [1.8.8] — 2026-07-07

### Fixed
- **Chronological order now follows real activity.** A session has two
  clocks: the last timestamp inside the transcript and the file's mtime.
  Claude Code appends metadata records without timestamps (ai-title,
  last-prompt, mode), so the content clock can be hours stale while the file
  is being written right now — such sessions showed `[6h]` with a live `●`
  and sorted far down the list. Sorting and the `[age]` label now use the
  newer of the two clocks — the same signal as the live marker, so age,
  order, and liveness can never contradict each other. Guarded by a
  regression test.

## [1.8.7] — 2026-07-07

### Changed
- **Clean session rows.** One format in both modes: `[age] Title` with the
  age once on the left and the full remaining width for the title. The
  right-side description now shows only the live `●` marker; the session id
  and other details moved to the tooltip (id also stays on the context
  menu → Copy session id). Left padding halved.

### Fixed
- **Reveal after a window reload no longer needs a second press.** Reveal now
  confirms the tree selection actually took and retries once after a short
  beat when the first attempt lands on a still-rendering tree.

## [1.8.6] — 2026-07-07

### Added
- **CI-enforced read-only guarantee**: a test suite (`npm test`, zero
  dependencies, run by GitHub Actions on every push) patches every mutating
  filesystem API, runs the full indexing and conversation-extraction
  pipeline, and fails the build if anything ever writes inside `~/.claude`.
  Also verifies transcript bytes are untouched and that concurrent opens
  create exactly one panel.
- Workspace trust declarations in the manifest (`untrustedWorkspaces`:
  limited — reading works everywhere, resume prefers trusted;
  `virtualWorkspaces`: false — sessions live on the local disk).

### Fixed
- **Resume now validates the session id as a strict UUID** before it is used
  in a terminal command (ids come from filenames; a crafted filename in a
  shared session folder could otherwise inject shell commands). Applies to
  both the tree context menu and the viewer's resume button.

## [1.8.5] — 2026-07-07

### Fixed
- Double-clicking (or otherwise rapid-firing) a session row no longer opens
  two identical conversation panels; concurrent opens for the same session
  now share one in-flight extract.
- `Reveal current session` now awaits the re-index fully before touching tree
  nodes, expands the revealed folder, and surfaces a warning message instead
  of silently swallowing reveal failures.

### Changed
- Folder rows with the same basename across different projects now show a
  shortened parent path in the description (e.g. `~/yury-vibe-coding · 6`)
  instead of being indistinguishable.
- Chronological group ids no longer include a positional index, so refreshes
  that reorder groups no longer reset their expansion state.
- Session selection is now persisted to disk only when a conversation is
  opened, revealed, or the grouping mode is toggled — plain tree clicks only
  update the in-memory selection.

## [1.8.4] — 2026-07-06

### Fixed
- Switching between Folders A-Z and Chronological now keeps the last selected /
  reviewed session selected and expands its folder in the new mode.
- Chronological folder rows no longer show the session count after the folder
  name; the visible `[age]` label is the important signal in that mode.

## [1.8.3] — 2026-07-06

### Changed
- Chronological mode now renders visible `[age]` labels in folder and session
  row text, so "last updated" remains visible even when VS Code clips the
  right-side description column.

## [1.8.2] — 2026-07-06

### Fixed
- The expand/collapse toolbar button now actually overrides VS Code's remembered
  tree expansion state by refreshing folder item ids when the button is used.

## [1.8.1] — 2026-07-06

### Changed
- Tree ordering is now exactly two modes:
  - **Folders A-Z**: one row per folder, alphabetically sorted, sessions newest
    first inside each folder.
  - **Chronological**: newest sessions first, still wrapped in folder rows; a
    folder can appear multiple times when its sessions are separated by time.
- Removed current-project pinning/special folder icon from the tree. All folder
  rows use the same folder spark icon, with only `· gone` marking deleted
  folders.
- Replaced the misleading native collapse-all button with explicit
  expand-folders / collapse-folders commands controlled by this extension.
- Removed the tree search button/command; VS Code's normal tree filtering is
  enough here and avoids duplicate search surfaces.
- README updated to describe the two actual tree modes.

## [1.8.0] — 2026-07-06

### Changed
- **Calmer, truthful tree.** One spark folder icon for every group; the only
  special mark is the project you currently have open (boxed icon), which is
  now **pinned to the top** of the tree. The dashed "outside the workspace"
  icon is gone — it marked ~95% of groups in a cross-project list.
- Groups whose folder no longer exists on disk (e.g. a renamed/deleted
  project) are marked `· gone` with an explanatory tooltip — their sessions
  stay browsable as history.
- README: new **How it works** section (where sessions come from, how
  grouping works, exactly when the list refreshes, conversation freshness).

### Removed
- Personal working notes (handoffs, findings/inputs ledger, agent config,
  backlog) are no longer tracked in the public repository; the packaged
  extension never included them.

## [1.7.3] — 2026-07-06

### Changed
- The reveal button on the Claude panel tab now uses the terracotta 8-ray
  Claude asterisk (`reveal-spark.svg`) instead of the generic `$(sparkle)`
  codicon, matching the new icon set. The status-bar reveal keeps the codicon
  (the status bar API only renders codicons).

## [1.7.2] — 2026-07-06

### Changed
- **New Claude-style icon set**: 8-ray terracotta asterisk (reads as Claude
  Code first). Color Marketplace tile with a small terminal cue
  (`extension-icon.svg` → `icon.png`), matching monochrome activity-bar
  `icon.svg`, and `favicon.svg`/`favicon-32.png` for web use.
- README screenshots now use absolute GitHub URLs so they render on the
  installed-extension page and the Marketplace, not only on GitHub.

### Fixed
- README no longer describes the removed content re-attribution (`≈`)
  behavior; the grouping section matches v1.7.1 reality.

## [1.7.1] — 2026-07-06

### Fixed
- **Working-folder grouping now uses the real transcript `cwd` as ground
  truth.** Sessions started in the current project root stay under the project
  name (for example `claude-sessions-viewer`) instead of being re-filed into a
  subfolder such as `assets` because that folder was mentioned in the
  transcript.
- Removed the misleading content-attribution marker (`≈`) from session rows.

## [1.7.0] — 2026-07-06

### Changed
- **Refresh is now on-demand, not background.** The filesystem watcher that
  re-indexed every ~20s (which re-sorted the tree and made rows jump while you
  were browsing) is gone. The list now refreshes only when the panel becomes
  visible, when you click ↻, and when you press reveal. The grouping and the
  newest→oldest-within-folder order are unchanged — the tree just holds still
  while you locate a session. Opening a session still reads its transcript
  fresh from disk and live-updates while open.

## [1.6.0] — 2026-07-06

### Changed
- **Publisher id is now `yurykoretskiy`** (was `yury`), matching the GitHub
  handle so the extension id is `yurykoretskiy.claude-sessions-viewer`. This is
  a one-time reinstall under the new id; locally-stored custom titles and the
  grouping-mode toggle reset once.
- **Unified activity-bar icon**: the left-rail icon is now the same filled
  four-point spark as the Marketplace tile (monochrome, so VS Code themes it
  white when active / gray when idle), replacing the outlined spark-with-lines.
  The reveal/status buttons keep the matching `$(sparkle)` codicon.

## [1.5.1] — 2026-07-06

### Changed
- Removed the speech-bubble icon from session rows in the tree — the freed
  space now goes to the session title.

## [1.5.0] — 2026-07-06

### Added
- **Settings are now first-class**: a ⚙ gear in the view title (and the
  "Claude Sessions: Open Settings" command) opens the extension's settings.
  Settings are grouped into titled sections (Claude Sessions Viewer /
  Conversation Viewer / Sessions Tree) with ordered, richly described options
  and dropdown labels — controllable like any Marketplace extension.
- Marketplace packaging: 256px PNG icon, keywords, gallery banner, and a
  `.vscodeignore` that keeps private working notes (findings/inputs/handoffs/
  docs/poc) out of the published package.

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
