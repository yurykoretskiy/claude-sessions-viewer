// Hero GIF + Marketplace screenshots generator. <!-- #claude -->
//
// Renders the REAL viewer page (viewer.js html()) with a fully SYNTHETIC
// demo session — no real transcripts, no personal data — then drives it in
// headless Chromium and captures: 3-4 static PNGs and an animated hero.gif
// (frames assembled with ffmpeg palettegen/paletteuse).
//
// Usage: npm install --no-save playwright && node tools/make-hero-assets.js
// Output: assets/screenshots/hero.gif, viewer-short.png, viewer-unfold.png,
//         viewer-search.png, viewer-short-light.png

const Module = require('module');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let themeSetting = 'dark';
const fakeVscode = {
  window: {
    createWebviewPanel() { return { webview: {}, onDidDispose() {}, reveal() {} }; },
    createTerminal() { return { show() {}, sendText() {} }; },
    showErrorMessage() {}, showInformationMessage() {},
  },
  ViewColumn: { One: 1, Beside: -2 },
  workspace: { getConfiguration: () => ({ get: (k, d) => (k === 'theme' ? themeSetting : d) }) },
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

// ---- Synthetic demo session (emulated, deliberately generic) ----
const D1 = '2026-07-08';
const D2 = '2026-07-09';
const MESSAGES = [
  { role: 'user', ts: `${D1}T17:42:00Z`,
    text: 'The sync worker retries forever when the API answers 429. Can you find out why?' },
  { role: 'assistant', ts: `${D1}T17:42:40Z`,
    text: 'Looking at `worker/sync.js` — the retry loop ignores the `Retry-After` header, and **the backoff resets on every queue tick**, so it hammers the API at full speed.' },
  { role: 'assistant', ts: `${D1}T17:43:30Z`,
    text: 'Here is the problem spot:\n```js\nwhile (queue.length) {\n  const res = await push(queue[0]);\n  if (res.status === 429) continue; // no backoff!\n  queue.shift();\n}\n```\n**Root cause:** the `continue` skips straight back into the loop.' },
  { role: 'user', ts: `${D1}T17:45:00Z`,
    text: 'fix it and add a test' },
  { role: 'assistant', ts: `${D1}T17:47:10Z`,
    text: 'Applied the fix — `backoffMs` now doubles up to 60s and honors `Retry-After` when present.' },
  { role: 'assistant', ts: `${D1}T17:48:00Z`,
    text: '**Done.** 12/12 tests pass, including the new `retry-backoff.test.js`:\n- 429 → waits `Retry-After` seconds before the next attempt\n- repeated 429 → exponential backoff, capped at 60s\n- success resets the backoff window' },
  { role: 'user', ts: `${D2}T09:05:00Z`,
    text: 'morning — deploy went out. can you double-check the worker logs look sane?',
    attachments: [{ id: 'att-demo-1', mediaType: 'image/png', kind: 'image', data: '' }] },
  { role: 'assistant', ts: `${D2}T09:06:20Z`,
    text: 'Checked the last 2h of logs: zero retry storms, backoff kicks in exactly once per 429 and the queue drains normally. The p95 push latency dropped from 3.1s to 240ms.' },
  { role: 'user', ts: `${D2}T09:08:00Z`,
    text: 'perfect. summarize what changed for the changelog' },
  { role: 'assistant', ts: `${D2}T09:08:45Z`,
    text: '**Changelog entry:**\n> Fixed: sync worker no longer retry-storms on 429 responses. Backoff is exponential (capped at 60s) and honors `Retry-After`. Added regression tests.' },
];

function pageHtml(theme) {
  themeSetting = theme;
  const viewer = new ConversationViewer({});
  const html = viewer.html({
    session: { id: 'c0ffee00-1234-4abc-9def-0123456789ab', file: '/demo/sync-service/session.jsonl', cwd: '/demo/sync-service' },
    convo: { firstTs: MESSAGES[0].ts, lastTs: MESSAGES[MESSAGES.length - 1].ts, messages: MESSAGES },
    title: 'Fix 429 retry storm in sync worker',
    folder: 'sync-service',
  });
  const nonce = html.match(/script-src 'nonce-([^']+)'/)[1];
  return html.replace('<head>',
    `<head><script nonce="${nonce}">window.acquireVsCodeApi = () => ({ postMessage(){}, setState(){}, getState(){ return {}; } });</script>`);
}

(async () => {
  const { chromium } = require('playwright');
  const cached = path.join(os.homedir(),
    'Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const browser = await chromium.launch(fs.existsSync(cached) ? { executablePath: cached } : {});
  const page = await browser.newPage({ viewport: { width: 880, height: 560 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-hero-'));
  const outDir = path.join(__dirname, '..', 'assets', 'screenshots');
  const frames = [];
  let frameN = 0;
  const load = async (theme) => {
    const f = path.join(tmp, `demo-${theme}-${frameN}.html`);
    fs.writeFileSync(f, pageHtml(theme));
    await page.goto('file://' + f, { waitUntil: 'load' });
    await page.$eval('.chat', (el) => { el.style.scrollBehavior = 'auto'; el.scrollTop = 0; });
    await page.waitForTimeout(120);
  };
  // Park the cursor and let transient chrome (tooltips, the position pill,
  // hover states) fade before any capture.
  const settle = async () => { await page.mouse.move(30, 520); await page.waitForTimeout(1000); };
  const shot = async (name) => {
    await settle();
    const p = path.join(outDir, name);
    await page.screenshot({ path: p });
    return p;
  };
  const frame = async (holdSeconds) => {
    await settle();
    const p = path.join(tmp, `frame-${String(frameN++).padStart(3, '0')}.png`);
    await page.screenshot({ path: p });
    frames.push({ p, d: holdSeconds });
  };

  // ---- Scene 1: Short mode — the whole session scannable, all folded ----
  await load('dark');
  await frame(1.6);
  await shot('viewer-short.png');

  // ---- Scene 2: click one bubble — the full turn unfolds in place ----
  await page.click('.msg[data-i="1"]');
  await page.waitForTimeout(150);
  await frame(2.0);
  await shot('viewer-unfold.png');

  // ---- Scene 3: switch to Full — everything unfolds (rich markdown) ----
  await page.click('[data-d="full"]');
  await page.waitForTimeout(150);
  await page.$eval('.chat', (el) => { el.scrollTop = 0; });
  await frame(1.6);

  // ---- Scene 4: search with live highlight + match count ----
  await page.click('#searchToggle');
  await page.fill('#search', 'backoff');
  await page.waitForTimeout(200);
  await frame(2.2);
  await shot('viewer-search.png');

  // ---- Scene 5: back to Short (loop point) ----
  await page.click('#clearSearch');
  await page.click('#clearSearch'); // second press closes the bar
  await page.click('[data-d="short"]');
  await page.waitForTimeout(150);
  await frame(1.2);

  // ---- Light-theme still ----
  await load('light');
  await shot('viewer-short-light.png');

  await browser.close();

  // ---- Assemble hero.gif with ffmpeg (concat demuxer + palette) ----
  const list = frames.map((f) => `file '${f.p}'\nduration ${f.d}`).join('\n') +
    `\nfile '${frames[frames.length - 1].p}'\n`;
  const listFile = path.join(tmp, 'frames.txt');
  fs.writeFileSync(listFile, list);
  const gif = path.join(outDir, 'hero.gif');
  execFileSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', 'scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    '-loop', '0', gif], { stdio: 'pipe' });

  const kb = (f) => Math.round(fs.statSync(f).size / 1024) + ' KB';
  console.log('hero.gif:', kb(gif));
  for (const n of ['viewer-short.png', 'viewer-unfold.png', 'viewer-search.png', 'viewer-short-light.png'])
    console.log(n + ':', kb(path.join(outDir, n)));
})().catch((err) => { console.error('ASSET GEN FAILED:', err.message); process.exit(1); });
