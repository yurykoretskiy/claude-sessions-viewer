# Changelog

All notable changes to this extension. Format follows
[Keep a Changelog](https://keepachangelog.com); versions follow
[SemVer](https://semver.org). Each release is tagged and published with an
installable `.vsix` on the
[Releases page](https://github.com/yurykoretskiy/claude-sessions-viewer/releases).

## [1.16.1] — 2026-07-10

### Changed
- Viewer filter buttons now follow `All | Agent | You` order and use the same
  configurable labels as message headers, copies, exports, and the settings
  menu.
- Custom labels keep the user's typed casing instead of being forced to
  uppercase, and the default user filter no longer special-cases `USER` as
  `Me`.

## [1.16.0] — 2026-07-10

### Changed
- Claude messages now use the approved **Code Indigo** surface, while the
  orange Claude spark remains as a small identity accent instead of tinting
  the whole message like a warning.
- User messages now use **Notebook Blue**, avoiding the success/completed
  meaning of the previous green while keeping the two speakers distinct.
- Inactive folder icons are neutral. A folder containing a live session gets
  an indigo outline with the Claude spark, and the live session row gets its
  own compact Claude presence icon instead of a generic gray dot.

## [1.15.2] — 2026-07-09

### Fixed
- Inline code, quotes, attachment chips, and table backgrounds were
  hardcoded to translucent **white**, which made them unreadable blur
  pills in dark themes. They now derive from the theme's foreground color
  (`color-mix`), so they read correctly in light, dark, and system themes.

## [1.15.1] — 2026-07-09

### Fixed
- Folded messages containing a **code block** rendered at full height —
  CSS line-clamp cannot fracture scroll containers, so a hard height cap
  now guarantees every folded preview stays preview-sized. The browser
  harness gained a pixel-height check so this class of bug can't pass
  again on class names alone.

## [1.15.0] — 2026-07-09

### Added
- **Bold rendering.** `**bold**` in messages now renders as real bold — it
  used to show raw asterisks (the inline markdown handled only code and
  links).
- **Visible fold chevron on every bubble.** Each message shows a corner
  `⌄`/`⌃` control, so you can always see that a message is folded and toggle
  it — in both Short and Full mode, per message, any mix at once.
- New setting `claudeSessionsViewer.shortPreviewLines` (default 4): how many
  lines a folded message shows as its preview.

### Changed
- **Short is now the default** — sessions open with every message folded to
  a 4-line preview (twice the previous 2-line clamp); unfold what you want
  to read.
- **"Read more" / "Show less" removed entirely.** One mechanism remains:
  fold/unfold. Short|Full sets the default for all messages; the chevron
  (or click) overrides per bubble. No more stacked expansion steps.

## [1.14.0] — 2026-07-09

### Changed
- **One bubble per turn.** Consecutive assistant messages — the progress
  notes an agent writes between tool calls plus its final answer — now merge
  into a single bubble with thin separators between the parts, so it is
  always clear where a message starts and ends. A user message always starts
  a new bubble. Turn boundaries come from the original transcript order, so
  the Me/CLAUDE filter never changes how turns are grouped.
- **One fold, one click.** In Short mode, clicking a folded bubble now shows
  the entire turn at full length in a single click — the inner "Read more"
  cap no longer stacks on top of the fold. Clicking the name header folds it
  back. In Full mode, "Read more" keeps working for very long messages as
  before.
- **The position rail is now the scrollbar.** The right-hand rail can be
  dragged to scroll (with a wider grab area and a grow-on-hover thumb), and
  the native scrollbar is hidden in the chat area — one affordance instead
  of two overlapping ones.

## [1.13.0] — 2026-07-09

### Changed
- **Replaced Scan mode with Short/Full fold.** Scan's one-line text previews
  are gone entirely — Short mode now renders every message exactly like Full
  mode and clamps the bubble to 2 lines with pure CSS (`-webkit-line-clamp`).
  Click a folded bubble to unfold it in place (real markdown, code, links,
  attachments — nothing is a text preview); click its name header to fold it
  back. The density toggle and the `claudeSessionsViewer.viewerDensity`
  setting are renamed `Short`/`Full` (`short`/`full`), default `Full`. Any
  older `read`/`scan` value from a previous release is silently treated as
  `full`. Search auto-unfolds matching messages in Short mode and folds
  everything back when the search is cleared, same as Scan's search behavior.

### Fixed
- Scan mode (v1.12.0) built its one-line previews with
  `replace(/\s+/g, ' ')` written directly inside the webview's embedded
  template literal, where an un-doubled backslash silently drops — so the
  browser actually ran `replace(/s+/g, ' ')` and every letter "s" was deleted
  from every preview. Previews are gone as of this release, so the bug class
  is structurally impossible; a regression test now also fails the build if a
  degraded `/s+/` regex ever reappears in the generated script.

## [1.12.0] — 2026-07-08

### Added
- **Scan/Read density toggle.** Scan mode renders every message as a
  single-line, role-striped row with a right-aligned time — built for
  scrolling a long session in seconds. Click a row to expand it in place to
  the full bubble (markdown, code, links, attachments); click it again (or
  its fold control) to collapse. Search auto-expands matching rows in Scan
  mode and folds everything back when cleared. The choice persists via the
  new `claudeSessionsViewer.viewerDensity` setting and is restored for new
  panels.
- Instant custom tooltips (`data-tip`, ~150ms) on the icon-only header/control
  buttons, replacing the native `title` tooltip's slow OS delay.

### Changed
- **Native typography.** The viewer's prose and monospace text now follow
  VS Code's own font family/size (`--vscode-font-family`,
  `--vscode-editor-font-family`, etc.) instead of a hardcoded font stack, so
  it matches the official Claude panel's look. Markdown headings and tables
  now scale in `em` instead of a fixed `px` size.
- **One-row controls.** The filter chips are now a compact segmented control
  (`All | Me | <agent>`), Search collapsed to an icon button, and everything
  else (copy conversation, export, copy raw path, reveal raw file, labels &
  theme) moved into a single `⋯` overflow menu. The header keeps only the
  title and the resume button. The control row never wraps. The old
  "Collapse long" / "Expand all" buttons are removed — the density toggle
  replaces them (per-message "Read more" still works in Read mode).

## [1.11.7] — 2026-07-08

### Fixed
- Replaced bottom padding with a real end-of-chat spacer after the final
  rendered message, so the last bubble has visible messenger-style resting
  space even inside VS Code's locked webview scroll container.

## [1.11.6] — 2026-07-08

### Fixed
- Locked the conversation webview page itself and kept scrolling inside the
  transcript pane, so the title/actions/filters remain visible instead of the
  widget drifting upward to a bare chat view.

## [1.11.5] — 2026-07-08

### Changed
- Increased the conversation viewer's bottom resting space so the final
  message can sit well above the jump button, closer to messenger/editor
  reading behavior.
- Changed the custom scroll-position rail from Claude/coral to a neutral
  muted rail color and shortened it above the bottom jump-button area.

## [1.11.4] — 2026-07-08

### Changed
- Added more bottom breathing room to the conversation viewer so the final
  messages do not sit tight against the bottom edge or jump button.

## [1.11.3] — 2026-07-08

### Added
- **Clickable image attachments.** User image blocks now render as attachment
  chips in the conversation viewer. Clicking a chip decodes that one image to
  a temp file and opens it in VS Code, avoiding heavy base64 image payloads in
  the webview.
- Speaker labels now include small role icons so Claude and user bubbles match
  the approved messenger mockup more closely.

### Changed
- Restored the conversation viewer shell to match
  `poc/messenger-viewer-v3-mockup.html` more closely: centered 820px pane,
  larger title/actions, v3 header/control spacing, bubble margins, and larger
  jump button.
- Collapse-all in the tree now keeps the folder containing the selected or
  revealed session expanded, so the current session stays visible instead of
  disappearing when the rest of the tree is folded.

## [1.11.2] — 2026-07-08

### Fixed
- **Conversation viewer opens again.** The `1.11.1` link-rendering change
  introduced an escaping-sensitive regex inside the generated webview script.
  Node-side tests passed, but VS Code received invalid JavaScript and rendered
  a blank webview. The link check now avoids that regex and the test suite now
  syntax-checks the actual generated webview script.

## [1.11.1] — 2026-07-08

### Fixed
- **Slash command inputs now render as user messages.** Claude stores commands
  such as `/checkpoint` as command markup in the transcript; the conversation
  extractor now preserves the command while still hiding internal meta blocks.
- **Links are clickable in the conversation viewer.** Markdown links and bare
  `http(s)`, `file://`, and local/relative paths now open through VS Code
  instead of staying inert text.
- **Image attachments are visible in user bubbles.** When a user message
  contains image blocks, the viewer now shows an attachment marker before the
  text so screenshots are not silently invisible.

### Changed
- Softened the user and Claude bubble backgrounds. Role color now comes mostly
  from the side stripes; Claude bubbles use a neutral cloud-gray fill instead
  of a pink/coral fill.

## [1.11.0] — 2026-07-08

### Added
- **Messenger-style conversation viewer.** The reader now focuses on fast
  review: user bubbles on the right with a green edge, Claude bubbles on the
  left with a coral edge, names visible by default, and long messages
  collapsible with **Read more** / **Show less**.
- **Inside-session search.** Search is hidden until requested from the main
  control row, then highlights matches, shows match count, and jumps
  previous/next inside the opened session.
- **Markdown-aware message rendering.** Viewer bubbles render compact
  headings, lists, inline code, fenced code blocks with copy buttons, quote
  blocks, and Markdown tables without leaving the chat layout.
- **Session orientation controls.** The viewer now includes a passive
  right-side scroll position rail, a sticky date context, **Collapse long** /
  **Expand all**, and a copy button for the raw session JSONL path.
- **Configurable speaker labels.** `userLabel`, `agentLabel`, and `showNames`
  now drive both the viewer and copy/export output.

### Changed
- Removed the normal-reader **plain flow** and **tools** toggles. Raw JSON and
  Markdown export cover those deeper/debugging needs while the viewer stays a
  messenger-style reader.
- The resume control is visually quieter and labeled as resuming in a Claude
  terminal so it does not look like the primary review action.
- Folder counts now render as `(N)` instead of a bare number.

## [1.10.4] — 2026-07-08

### Changed
- Removed the decorative spark marker from the conversation viewer header. It
  was not an action and duplicated the title/toolbar semantics.

## [1.10.3] — 2026-07-08

### Changed
- **The flat Session Timeline is now experimental and hidden by default.** It
  has real value for cross-project work history, but VS Code TreeView cannot
  render proper fixed columns or two-line rows, so the current title + folder
  presentation is not clear enough for the default/published experience.
  Folders A-Z remains the normal view; the timeline can still be enabled from
  Settings while a better two-column layout is designed.

## [1.10.2] — 2026-07-08

### Fixed
- **Extension details now lead with the safety positioning.** The manifest
  description now says the extension is read-only, local, and dependency-free
  instead of emphasizing folder launchers.
- **README screenshots now render from the packaged extension.** Screenshot
  links are package-relative paths instead of remote raw GitHub URLs, so the
  VS Code extension details page can render them from the installed `.vsix`.

## [1.10.1] — 2026-07-08

### Fixed
- **Timeline rows now keep the folder visible.** Long session titles are
  capped in the flat timeline so the right-side folder name does not get
  pushed out of view; the full title remains in the tooltip.
- **The view header now names the active mode.** The tree title switches
  between **Sessions by Folder** and **Session Timeline** instead of showing
  the static manifest name in both modes.

## [1.10.0] — 2026-07-08

### Changed
- **Mode 2 is now a flat session timeline.** Instead of re-ordered folder
  rows, it lists the sessions themselves — newest first, across all folders,
  interleaving preserved (session → other folder → back), which is the point
  when you work in several projects at once. Each row shows its folder name
  on the right; right-click → **Show in folder view** switches to Folders A-Z
  and reveals the session in its place. The two modes are now visually
  unmistakable: folders vs a flat list. Folders A-Z is untouched.
- Expand/collapse-folders toolbar buttons hide in timeline mode (there are
  no folders to expand there).

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
