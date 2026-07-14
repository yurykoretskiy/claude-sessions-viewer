# Backlog

#codex

## Viewer messenger experience

- [ ] Clean chat bubble styling.
  - Use a right-side green accent stripe for USER bubbles.
  - Use a left-side coral accent stripe for CLAUDE/agent bubbles.
  - Use Claude/coral coloring for agent bubbles.
  - Use a distinct user color, likely a soft messenger-style green rather than
    a saturated bright green, so long sessions stay readable.
  - Keep speaker names visible by default because future sessions may include
    Claude, Codex, or other agents.

- [ ] Viewer names and labels.
  - Keep `Show names` as a viewer option, but move it out of the main toolbar.
  - Default `Show names` to on.
  - Allow configuring the user display name.
  - Allow configuring the agent display name; default is `Claude`.

- [ ] Messenger Folding v1.
  - Long messages collapse earlier, around 600-700 characters.
  - Collapsed bubble shows preview plus `Read more`.
  - Expanded bubble shows full text plus `Show less`.
  - Add `Collapse long` and `Expand all`.
  - Preserve expanded/collapsed state while the webview stays open.

- [ ] Right-side scroll position rail.
  - Add a passive thin rail on the right side of the conversation.
  - While scrolling, show a floating marker such as `08 Jul · msg 241 / 273`.
  - Do not make it draggable and do not replace the native scrollbar.
  - Hide/fade the marker when the user is not scrolling.

- [ ] Sticky date behavior.
  - Keep date context visible while scrolling, WhatsApp-style.
  - Update the date based on the currently visible message.
  - Avoid large date dividers taking too much vertical space.

- [ ] Code and quote rendering.
  - Detect fenced code blocks and render them as code blocks.
  - Add a copy button for code blocks as a later improvement.
  - Detect quote-style text and render it with a subtle vertical accent.
  - Use the accent stripe here, not on every USER bubble.

- [ ] Inside-session search.
  - Add search inside the opened conversation viewer, not as the primary tree
    workflow.
  - Hide the search field by default; reveal it only after pressing a larger
    `Search` control in the main filter/control row.
  - Search exact text across the current session's USER and CLAUDE messages.
  - Show result count and current match, for example `3 / 12`.
  - Provide previous/next match controls.
  - Highlight matches inside bubbles.
  - Jump to the matched message and temporarily expand it if it was collapsed.
  - Allow role scope later: `All`, `Me`, `Claude`.
  - Keep tree/global search secondary because users often do not remember which
    session contains the text.

- [ ] Simplify the viewer top controls.
  - Remove `tools` from the normal viewer UI. If deep transcript inspection is
    needed, open the raw JSON.
  - Remove `plain flow` from the normal viewer UI. Export Markdown covers the
    plain/document need.
  - Keep role filters visible: `All`, `Me`, `Claude`.
  - Put `Search` on the same row as `All`, `Me`, `Claude`, `Collapse long`,
    and `Expand all`, separated by dividers.
  - Keep the session id visible in the compact metadata line.
  - Add a copy button that copies the full raw JSON session path.
  - Do not show the full session id/raw JSON details block by default; use the
    visible session id plus copy/open actions.
  - Keep the run/resume control visually neutral. The play symbol is fine, but
    it should read as `resume in Claude terminal`, not as the primary action.
  - Use a names-specific control such as `Aa` instead of a generic settings
    gear when the menu only controls speaker names/labels.

## Tree and navigation

- [ ] Folder count display.
  - Change folder counts from `claude-sessions-viewer 4` to
    `claude-sessions-viewer (4)`.

- [ ] Revealed session marker.
  - Replace the old timeline/grouping toolbar idea with a small marker for the
    currently revealed/selected session.
  - Prefer a row-level marker in the tree, not another toolbar button.
  - Keep the current session visually findable.

- [ ] Collapse folders should keep the revealed session visible.
  - If the user reveals the current session, then presses collapse/expand, the
    extension should not lose that revealed context.
  - Collapse all should probably collapse everything except the folder
    containing the revealed session.

- [ ] Timeline / flat history mode redesign.
  - Keep disabled by default for now.
  - Revisit later as either a proper webview history mode or a clearer
    two-column mockup before TreeView implementation.
  - Do not ship the unclear current flat timeline as default.

## Marketplace polish

- [ ] Marketplace/readme polish.
  - Keep positioning: read-only, local, safe, dependency-free.
  - Make screenshots reflect the final messenger viewer, not the current rough
    state.
  - Ensure images render inside VS Code extension details.

## Suggested implementation order

1. Clean bubble styling and remove the default USER stripe.
2. Messenger Folding v1.
3. Inside-session search.
4. Scroll rail plus scroll position marker.
5. Folder count `(N)`.
6. Revealed-session marker and collapse behavior.
7. Code/quote rendering.
8. Marketplace screenshot/readme refresh.
9. Smart resume — "Resume in Claude panel": official extension exposes
   `claude-vscode.editor.open(sessionId, prompt, viewColumn)` (verified in
   bundle v2.1.204, flows to `--resume`). Two actions: run-in-terminal
   (always works) + run-in-panel (when official ext installed AND session
   cwd matches current workspace; fallback = terminal). Offer from tree row
   and from opened viewer panel. Undocumented API — guard with
   getCommands() + try/catch. Mention in extension description when shipped.
10. Pre-publish CHANGELOG squash — collapse the pre-Marketplace churn
    (esp. Scan added in 1.12.0 → removed in 1.13.0; micro-versions) into a
    few honest, user-relevant entries. Nobody has installed anything yet,
    so pre-publish history can be curated. Do it as the LAST step before
    `vsce publish`.
11. README images broken in local extension details page — root cause
    found (09 Jul): PNGs ARE in the vsix and tracked in git, paths are
    relative and correct; VS Code's details page fails to resolve relative
    paths for sideloaded extensions. Fix: package with
    `--baseImagesUrl https://raw.githubusercontent.com/yurykoretskiy/claude-sessions-viewer/master`
    (add to build-vsix.sh) so the packaged readme carries absolute URLs.
    Verify on all 3 surfaces after: local details page, GitHub, Marketplace.
12. README/details rewrite — shorten hard. Voice: peer-to-peer, "why I
    built this" usability narrative, NOT marketing/LinkedIn-ish. Two
    anchors: (a) each feature exists because of a real workflow need —
    say the need; (b) safety: read-only by design, zero write access,
    CI-proven. Hero GIF + 2-3 screenshots carry the visual load; text gets
    much shorter. Fable drafts, Yury tunes the voice. Pairs with 10 + 11
    as the pre-publish polish batch.
13. Fold chevron polish (from 1.15.0 review): (a) reconsider placement —
    top-right corner may be wrong side/position; (b) hide the chevron on
    messages that already fit inside the preview clamp (nothing to fold —
    detect overflow and suppress the control). Yury unsure the current
    always-on chevron is right.

## Global search follow-ups <!-- #claude -->

- [ ] Tool-content search (deferred from search v1, 14 Jul 2026). v1
  searches user + assistant chat text only — the same text the viewer
  renders. If a few days of real use show copy-paste sources going
  unfound, add an opt-in scope for tool traffic in two tiers:
  Claude-authored tool inputs (Write/Edit file bodies, Bash commands)
  first, raw tool results second. Design notes: keep the chat index
  small/in-memory; tool tiers should stream raw JSONL on demand rather
  than inflate the index.
- [ ] DISCUSS: tree single-click behavior. Clicking a session row
  auto-opens the read-only conversation. Yury suspects this is wrong —
  question to settle: what SHOULD a single click show (select only?
  preview? nothing until double-click / explicit button?).
