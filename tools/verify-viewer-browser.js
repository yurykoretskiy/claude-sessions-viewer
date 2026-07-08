// Browser verification harness for the conversation viewer. <!-- #claude -->
//
// Runs the REAL generated webview page (HTML + CSS + embedded script) in
// headless Chromium and exercises the interactive behavior node tests cannot:
// turn-merge bubble structure, Short-mode fold/unfold semantics, and rail
// dragging. Requires `npm install --no-save playwright` (browsers are cached
// in ~/Library/Caches/ms-playwright).
//
// Scope, per docs/viewer-lineage-and-verification-codex.md: a standalone
// browser proves the page logic, NOT the installed VS Code webview lifecycle.
// The final check is always ./build-vsix.sh --install + a reloaded VS Code.
//
// Usage: node tools/verify-viewer-browser.js

const Module = require('module');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let viewerDensity = 'full';
const fakeVscode = {
  window: {
    createWebviewPanel() { return { webview: {}, onDidDispose() {}, reveal() {} }; },
    createTerminal() { return { show() {}, sendText() {} }; },
    showErrorMessage() {}, showInformationMessage() {},
  },
  ViewColumn: { One: 1, Beside: -2 },
  workspace: { getConfiguration: () => ({ get: (k, d) => (k === 'viewerDensity' ? viewerDensity : d) }) },
  Uri: { joinPath() { return {}; }, file(p) { return { fsPath: p }; }, parse(v) { return { value: v }; } },
  env: { clipboard: { writeText() {} }, openExternal() {} },
  commands: { executeCommand() {} },
  ConfigurationTarget: { Global: 1 },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return fakeVscode;
  return origLoad.call(this, request, ...rest);
};

const { ConversationViewer } = require('../viewer');

const LONG_BODY = ('line of filler text to exceed the display cap\n').repeat(30) +
  '\n```js\nconst x = 1;\nconst y = 2;\nconst z = 3;\nconst w = 4;\nconst v = 5;\n```\n' + 'ENDTOKEN';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-harness-'));
const file = path.join(tmp, 'fixture.jsonl');
fs.writeFileSync(file, '');

function pageHtml(density) {
  viewerDensity = density;
  const viewer = new ConversationViewer({});
  const html = viewer.html({
    session: { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp },
    convo: {
      firstTs: '2026-01-01T10:00:00Z',
      lastTs: '2026-01-01T10:03:00Z',
      messages: [
        { role: 'assistant', text: 'progress note one', ts: '2026-01-01T10:00:00Z' },
        { role: 'assistant', text: LONG_BODY, ts: '2026-01-01T10:00:30Z' },
        { role: 'user', text: 'a user question', ts: '2026-01-01T10:01:00Z' },
        { role: 'assistant', text: 'final answer with **boldtoken** inside', ts: '2026-01-01T10:02:00Z' },
      ],
    },
    title: 'Harness', folder: 'F',
  });
  // Stub the VS Code webview API with the page's own nonce so the CSP allows it.
  const nonce = html.match(/script-src 'nonce-([^']+)'/)[1];
  return html.replace('<head>',
    `<head><script nonce="${nonce}">window.acquireVsCodeApi = () => ({ postMessage(){}, setState(){}, getState(){ return {}; } });</script>`);
}

(async () => {
  const { chromium } = require('playwright');
  // Use the Chromium already cached on this machine (never download new
  // browsers); fall back to Playwright's default resolution if absent.
  const cached = path.join(os.homedir(),
    'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const browser = await chromium.launch(fs.existsSync(cached) ? { executablePath: cached } : {});
  const page = await browser.newPage({ viewport: { width: 700, height: 500 } });
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE ERROR:', m.text()); });
  // page.setContent() reuses the document, so the previous page's CSP nonce
  // would still be enforced and block the next page's scripts. A real file://
  // navigation gives each scenario a fresh document and fresh CSP.
  let pageN = 0;
  const load = async (density) => {
    const f = path.join(tmp, 'page-' + (pageN++) + '.html');
    fs.writeFileSync(f, pageHtml(density));
    await page.goto('file://' + f, { waitUntil: 'load' });
  };
  const results = [];
  const check = (name, fn) => { fn(); results.push('ok - ' + name); };

  // ---- Full mode ----
  await load('full');
  const bubbles = await page.$$eval('.msg', els => els.map(e => ({
    cls: e.className,
    parts: e.querySelectorAll('.part').length,
    seps: e.querySelectorAll('.part-sep').length,
  })));
  check('turn-merge: 4 messages render as 3 bubbles', () => assert.strictEqual(bubbles.length, 3));
  check('turn-merge: first bubble has 2 parts + 1 separator', () =>
    assert.deepStrictEqual([bubbles[0].parts, bubbles[0].seps], [2, 1]));
  check('turn-merge: user bubble stays single-part', () => assert.strictEqual(bubbles[1].parts, 1));

  // Full mode: everything unfolded by default, Read more is GONE, long text
  // fully visible, bold renders as <strong>.
  assert.strictEqual(await page.$$eval('.msg.folded', els => els.length), 0, 'full mode starts all-unfolded');
  assert.strictEqual(await page.$$eval('.more', els => els.length), 0, 'Read more no longer exists');
  assert.ok((await page.$eval('.chat', el => el.textContent)).includes('ENDTOKEN'), 'long text fully visible in full mode');
  assert.strictEqual(await page.$eval('.msg strong', el => el.textContent), 'boldtoken', '**bold** renders as <strong>');
  results.push('ok - full mode: all unfolded, no Read more, long text fully visible');
  results.push('ok - markdown: **bold** renders as <strong>');

  // Per-bubble fold in FULL mode: every bubble has a chevron; chevron folds
  // just that bubble, click unfolds it again.
  assert.strictEqual(await page.$$eval('.fold-ind', els => els.length), 3, 'every bubble has a fold chevron');
  await page.click('.msg[data-i="0"] .fold-ind');
  assert.ok(await page.$('.msg[data-i="0"].folded'), 'chevron folds one bubble in full mode');
  assert.strictEqual(await page.$$eval('.msg.folded', els => els.length), 1, 'only that bubble folded');
  await page.click('.msg[data-i="0"]');
  assert.strictEqual(await page.$$eval('.msg.folded', els => els.length), 0, 'click unfolds it back');
  results.push('ok - full mode: chevron folds/unfolds a single bubble');

  // ---- Short mode ----
  await load('short');
  const dbg = await page.evaluate(() => ({ density: document.body.dataset.density, msgs: document.querySelectorAll('.msg').length, folded: document.querySelectorAll('.msg.folded').length }));
  assert.strictEqual(dbg.density, 'short', 'short page carries data-density=short (got ' + JSON.stringify(dbg) + ')');
  assert.strictEqual(dbg.folded, 3, 'all 3 bubbles start folded (got ' + JSON.stringify(dbg) + ')');
  const clampLines = await page.$eval('body', b => getComputedStyle(b).getPropertyValue('--fold-lines').trim());
  assert.strictEqual(clampLines, '4', 'folded preview is 4 lines by default');

  // PIXEL check, not just class check (a folded code block once rendered at
  // full height because line-clamp can't fracture scroll containers): every
  // folded bubble must actually be preview-sized.
  const heights = await page.$$eval('.msg.folded .bodywrap', els => els.map(e => Math.round(e.getBoundingClientRect().height)));
  const maxAllowed = await page.$eval('body', (b) => 4 * 1.52 * parseFloat(getComputedStyle(b).fontSize) + 8);
  assert.ok(heights.every(h => h <= maxAllowed), 'every folded preview is visually clamped (max ' + maxAllowed + '): ' + JSON.stringify(heights));
  results.push('ok - short mode: folded previews are pixel-clamped incl. code blocks (' + heights.join(', ') + 'px)');

  // One click unfolds the ENTIRE merged turn — full long text, no Read more.
  await page.click('.msg[data-i="0"]');
  const unfoldedText = await page.$eval('.msg[data-i="0"]', el => el.textContent);
  assert.ok(unfoldedText.includes('ENDTOKEN'), 'single click reveals full long text');
  assert.strictEqual(await page.$$eval('.msg.folded', els => els.length), 2, 'other bubbles stay folded');
  results.push('ok - short mode: one click = entire turn, others stay folded');

  // Header and chevron both fold it back.
  await page.click('.msg[data-i="0"] .who');
  assert.ok(await page.$('.msg[data-i="0"].folded'), 'header click folds the bubble back');
  results.push('ok - short mode: header click folds back');

  // ---- Rail drag ----
  await load('full');
  await page.$eval('.chat', el => { el.style.scrollBehavior = 'auto'; el.scrollTop = 0; });
  const before = await page.$eval('.chat', el => el.scrollTop);
  const rail = await page.$('#rail');
  const box = await rail.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 4, { steps: 8 });
  await page.mouse.up();
  const after = await page.$eval('.chat', el => el.scrollTop);
  const max = await page.$eval('.chat', el => el.scrollHeight - el.clientHeight);
  assert.ok(max > 50, 'fixture actually scrolls (' + max + 'px)');
  assert.ok(after > before && after > max * 0.9, 'rail drag scrolled to near-bottom: ' + after + '/' + max);
  results.push('ok - rail: drag to bottom scrolls the chat (' + Math.round(after) + '/' + max + 'px)');

  const scrollbarHidden = await page.$eval('.chat', el => el.offsetWidth === el.clientWidth);
  assert.ok(scrollbarHidden, 'native scrollbar takes no layout space');
  results.push('ok - rail: native scrollbar hidden, rail is the single affordance');

  await browser.close();
  console.log(results.join('\n'));
  console.log('# browser harness: ' + results.length + ' checks passed');
})().catch((err) => { console.error('HARNESS FAILED:', err.message); process.exit(1); });
