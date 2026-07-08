# Viewer Lineage And Verification — Claude lane

#claude

Companion to `viewer-lineage-and-verification-codex.md` (Codex's contract,
read-only for Claude). Same purpose, same evidence hierarchy: source-to-target
lineage for viewer changes made in the Claude lane, so nothing drifts between
what was asked, what was shipped, and what was actually proven.

## Target Surface

Identical to the Codex contract: the installed VS Code extension webview.
Browser or node evidence is supporting, never final. Final check is always
`./build-vsix.sh --install` + reloaded VS Code + the real session
`aecfe794-a30f-42d5-b1b2-850b49b087fb`.

## Lineage (source → target)

| Version | Source (what Yury asked) | Target (what shipped) | Proven by |
| --- | --- | --- | --- |
| 1.12.0 | Reader v2: native fonts, one-row controls, instant tooltips, fast scan of long sessions | Typography vars, segmented controls + ⋯ menu, data-tip tooltips, Scan preview rows | 26/26 node tests; **Scan previews FAILED in the installed webview** (raw markdown + `/s+/` escaping bug) — recorded, not hidden |
| 1.13.0 | "Scan previews are gibberish; bring back fold/unfold, Short and Full" | Scan removed entirely; Short = CSS line-clamp of the real rendered bubble | 27/27 node tests incl. escaping-trap regression; installed check by Yury surfaced the next three issues |
| 1.14.0 | "One bubble got split into many; Read more stacks on the fold; the rail can't be dragged" | One bubble per assistant turn (parts + separators); Short unfold = whole turn in one click; draggable rail, native scrollbar hidden | 28/28 node tests + 9-check browser harness (`tools/verify-viewer-browser.js`) + installed-webview checklist below |

## What each 1.14.0 change means (no-drift statements)

- **Turn-merge** happens at render time in the webview script only. The
  transcript, the index, copy/export payloads, and `~/.claude` files are
  untouched. Turn boundaries are computed from the original message order, so
  filters cannot change grouping.
- **Unified fold**: `Short` folded = 2-line CSS clamp of the real render;
  unfolded = entire turn at full length (`forceFull` bypasses the Read-more
  cap). `Full` mode keeps per-part Read more. One mechanism per mode, never
  stacked.
- **Rail**: the custom rail is now the only scroll affordance in the chat
  (native scrollbar hidden). Drag maps pointer Y linearly to scrollTop.
  Keyboard/native scrolling behavior is unchanged.

## Verification ladder for Claude-lane viewer changes

1. `npm test` (CI-safe, zero deps — bubbles are built at runtime, so node
   tests assert generated-source invariants, not DOM behavior).
2. `node tools/verify-viewer-browser.js` — the REAL generated page in
   headless Chromium: bubble structure, fold clicks, rail drag. Uses the
   locally cached Chromium; never downloads browsers. Two traps it already
   caught: (a) `page.setContent()` keeps the previous document's CSP nonce —
   use real `file://` navigation per scenario; (b) template-literal
   backslash degradation is invisible to parse-only tests.
3. `./build-vsix.sh --install`, reload VS Code, open the real session, run
   the relevant items of Codex's Self-Test Checklist.
4. Yury's eyes on the installed webview are the acceptance gate. Anything he
   rejects gets a lineage row with the failure stated plainly.

## Standing traps (Claude lane, learned the hard way)

- Backslashes inside the `html()` template literal must be doubled (`\\s`),
  or the browser receives a different regex. Guarded by a regression test.
- `extension.js` contains em-space (U+2003) characters — edit only via
  scripts with escape verification, never assume the Edit tool handled it.
- Node tests passing ≠ webview working (blank-webview incident, Scan
  incident). Every UI change goes up the full ladder.
