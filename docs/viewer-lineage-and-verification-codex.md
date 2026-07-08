# Viewer Lineage And Verification

#codex

This document is the working contract for the messenger viewer after the
`1.11.x` redesign. It exists because a standalone generated-HTML check was
mistaken for proof of the real installed VS Code webview. Do not repeat that.

## Target Surface

The target surface is the installed VS Code extension webview, not a browser
copy of the HTML string.

The real check must happen after:

```bash
./build-vsix.sh --install
```

Then reload VS Code and open the conversation viewer from the extension.

Primary real-session test target:

```text
aecfe794-a30f-42d5-b1b2-850b49b087fb
```

## Product Target

The viewer should match the approved messenger direction:

- top chrome is always visible at the top of the webview:
  - title row;
  - resume-in-terminal action;
  - copy raw session path;
  - export Markdown;
  - open raw JSON;
  - names/settings control;
  - metadata row with folder, message count, session id, and dates;
  - filter/control row with All, Me, Claude, Collapse long, Expand all, Search.
- message area reads like a messenger:
  - Claude/agent messages left;
  - user messages right;
  - speaker names visible by default;
  - role icon beside the speaker name;
  - long messages collapse with Read more / Show less;
  - code, tables, links, and image attachment chips render inside bubbles.
- bottom reading behavior feels like a messenger/editor:
  - the last message can rest well above the bottom/jump button;
  - there is visible breathing room after the last bubble;
  - the scroll rail is navigation-colored, not Claude/coral.
- tree behavior preserves context:
  - after reveal-current, collapse-all must not hide the folder containing the
    revealed session.

## Lineage

Recent commits and what they changed:

- `a6e095c [gpt] Ship messenger session viewer`
  - shipped the messenger-style reader, hidden search, collapse/expand long
    messages, Markdown/code/table rendering, right-side scroll rail, and
    simplified normal-reader controls.
- `a4625de [gpt] Fix conversation command links and attachments`
  - preserved slash-command messages such as `/checkpoint`;
  - made links clickable through the extension host;
  - added image attachment markers;
  - softened bubble fills.
- `e6c6368 [gpt] Fix blank conversation webview`
  - fixed a generated-webview JavaScript regex escaping bug;
  - added a test that syntax-checks the actual generated webview script.
- `36d405e [gpt] Restore messenger mockup and clickable attachments`
  - moved the viewer shell closer to `poc/messenger-viewer-v3-mockup.html`;
  - added speaker role icons;
  - made image attachment chips clickable by decoding one base64 image to a
    temp file on demand;
  - made collapse-all keep the revealed folder open.
- `4a35c08 [gpt] Add viewer bottom breathing room`
  - increased the chat bottom padding from `18px` to `76px`.
- `b19c593 [gpt] Add messenger bottom space and neutral rail`
  - increased bottom padding further to `176px`;
  - changed the custom scroll rail from Claude/coral to a muted neutral rail;
  - shortened the rail above the bottom jump-button area.
- current fix commit: `[gpt] Keep viewer header fixed during chat scroll`
  - locked `html`, `body`, and `.viewer` against page-level scrolling;
  - kept scrolling constrained to `.chat`;
  - added a regression test for the header/controls visibility contract.

## Known Failure / Drift

Yury reported that the real installed webview can show chat bubbles at the top
without the expected top chrome visible.

Do not conclude the issue is fixed because:

- `viewer.js` contains the header markup;
- an extracted HTML string renders in Chrome;
- `node --check viewer.js` passes;
- `npm test` passes.

Those are useful checks, but they are not proof of the real VS Code webview.

The prior drift was:

1. extracted the generated HTML from `viewer.js`;
2. opened it in standalone Chrome;
3. saw the header render correctly;
4. treated that as stronger evidence than it was.

Correct interpretation: standalone Chrome proves only that the HTML string can
render in a normal browser with a stubbed `acquireVsCodeApi`. It does not prove
VS Code webview lifecycle, retained state, scroll restoration, focus behavior,
or installed extension behavior.

## Acceptable Evidence

Before saying the UI is fixed, collect at least these:

1. Source/unit evidence:

```bash
npm test
node --check viewer.js
node -e 'require("./indexer").indexAll("/tmp/claude-sessions-viewer-cache-test.json").then(s => console.log(s.length))'
```

2. Installed package evidence:

```bash
./build-vsix.sh --install
code --list-extensions --show-versions | rg 'claude-sessions|yury'
```

3. Real VS Code UI evidence:

- reload VS Code;
- open the Claude Sessions extension view;
- open session `aecfe794-a30f-42d5-b1b2-850b49b087fb`;
- visually confirm the top chrome is visible before scrolling;
- scroll near the bottom and confirm bottom breathing room;
- confirm the neutral rail is not confused with the Claude message stripe;
- press Search and confirm the search bar opens below the controls;
- search for a known token such as `checkpoint` or `renderSimpleMarkdown`;
- click a normal link and confirm it opens;
- click an image attachment chip and confirm the image opens in VS Code;
- press Collapse long and Expand all;
- use Reveal current session, then Collapse folders, and confirm the revealed
  session remains visible in its folder.

4. If a screenshot is used as evidence, it must be from the installed VS Code
extension webview, not from `/tmp/csv-viewer-debug.html` or a mockup.

## Self-Test Checklist For The Next UI Fix

Use this checklist before any final answer after changing `viewer.js`,
`conversation.js`, `extension.js`, or packaged assets:

- [ ] I inspected the current real failure screenshot/request and stated the
      exact surface being fixed.
- [ ] I did not rely on standalone Chrome as proof of installed behavior.
- [ ] I bumped `package.json` version for install-worthy changes.
- [ ] I added or updated `CHANGELOG.md`.
- [ ] `npm test` passes.
- [ ] `node --check viewer.js` passes.
- [ ] The headless indexer check returns a sane session count.
- [ ] `./build-vsix.sh --install` succeeds.
- [ ] `code --list-extensions --show-versions` reports the bumped version.
- [ ] VS Code was reloaded after install.
- [ ] The real installed webview was opened from the extension.
- [ ] Top chrome was visible at initial open.
- [ ] Bottom breathing room was checked at the final message.
- [ ] Neutral rail color was checked against Claude/coral message stripes.
- [ ] Search was opened and tested.
- [ ] Link opening was tested.
- [ ] Image attachment opening was tested when the session has image chips.
- [ ] Tree reveal plus collapse-all behavior was tested.
- [ ] Final answer clearly distinguishes tested facts from assumptions.

## Debugging Notes For Top-Chrome Disappearance

Likely areas to inspect if the top chrome still disappears:

- document-level scroll versus `.chat` scroll;
- retained webview state after `retainContextWhenHidden`;
- whether existing panels are reused without refreshing their HTML;
- `chat.scrollTop = chat.scrollHeight` side effects;
- CSS around `body`, `.viewer`, `.chatwrap`, and `.chat`;
- VS Code restoring webview scroll position from a previous panel;
- stale installed version or un-reloaded VS Code window.

Potential fix directions, to verify in real VS Code before shipping:

- prevent document/body scrolling and allow only `.chat` to scroll;
- make `.vhead`, `.controls`, and `.searchbar` sticky/fixed within `.viewer`;
- force existing panels to refresh HTML after install/version change only if
  needed;
- reset document scroll position on render and panel show if VS Code restores
  it incorrectly.

## Do Not Do

- Do not update README/Marketplace screenshots while the installed viewer UI is
  known to be unstable.
- Do not call a Chrome-rendered `/tmp` HTML proof equivalent to the installed
  VS Code webview.
- Do not publish the Marketplace package until the real installed viewer has
  passed the checklist above.
