// Viewer behavior tests with a stubbed vscode API:
// 1. Rapid concurrent open() calls (double-click) create exactly ONE panel.
// 2. The resume path refuses non-UUID session ids (they reach a shell).

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const vm = require('node:vm');
const fs = require('fs');
const os = require('os');
const path = require('path');

let panelsCreated = 0;
let terminalsCreated = 0;
let lastError = null;
let lastOpenedExternal = null;
let lastCommand = null;

const fakeVscode = {
  window: {
    createWebviewPanel() {
      panelsCreated++;
      return {
        webview: { onDidReceiveMessage() {}, postMessage() {}, set html(v) {}, get html() { return ''; } },
        onDidDispose() {},
        reveal() {},
      };
    },
    createTerminal() {
      terminalsCreated++;
      return { show() {}, sendText() {} };
    },
    showErrorMessage(msg) { lastError = msg; },
    showInformationMessage() {},
  },
  ViewColumn: { One: 1, Beside: -2 },
  workspace: { getConfiguration: () => ({ get: (k, d) => d }) },
  ConfigurationTarget: { Global: 1 },
  Uri: { joinPath() { return {}; }, file(fsPath) { return { fsPath }; }, parse(value) { return { value }; } },
  env: { clipboard: { writeText() {} }, openExternal(uri) { lastOpenedExternal = uri; } },
  commands: { executeCommand(command, uri) { lastCommand = { command, uri }; } },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return fakeVscode;
  return origLoad.call(this, request, ...rest);
};

const { ConversationViewer } = require('../viewer');

// small fixture transcript
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-viewer-'));
const file = path.join(tmp, 'fixture.jsonl');
fs.writeFileSync(
  file,
  JSON.stringify({ type: 'user', cwd: '/tmp/demo', timestamp: '2026-01-01T10:00:00Z', message: { content: 'hello' } }) + '\n' +
  JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T10:00:05Z', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n'
);

test('concurrent open() calls create exactly one panel', async () => {
  panelsCreated = 0;
  const viewer = new ConversationViewer({});
  const session = { id: 'race-test', file, size: 100 };
  const p1 = viewer.open(session, 'T', 'F');
  const p2 = viewer.open(session, 'T', 'F'); // same tick — the double-click
  const p3 = new Promise((r) => setTimeout(() => r(viewer.open(session, 'T', 'F')), 20)); // mid-flight
  await Promise.all([p1, p2, p3]);
  assert.strictEqual(panelsCreated, 1, 'one panel for three concurrent opens');
  await viewer.open(session, 'T', 'F'); // post-completion: reuse, not create
  assert.strictEqual(panelsCreated, 1, 'existing panel reused');
});

test('resume refuses a non-UUID session id (shell-injection guard)', async () => {
  const viewer = new ConversationViewer({});
  terminalsCreated = 0;
  lastError = null;

  const evil = { id: 'x; rm -rf ~', file, cwd: '/tmp' };
  await viewer.onMessage({ session: evil, convo: { messages: [] }, title: 'T', folder: 'F' }, { type: 'resume' });
  assert.strictEqual(terminalsCreated, 0, 'no terminal for malicious id');
  assert.match(String(lastError), /refusing to resume/);

  const good = { id: '11111111-2222-3333-4444-555555555555', file, cwd: '/tmp' };
  await viewer.onMessage({ session: good, convo: { messages: [] }, title: 'T', folder: 'F' }, { type: 'resume' });
  assert.strictEqual(terminalsCreated, 1, 'terminal opened for valid UUID');
});

test('openLink routes web links externally and local paths through VS Code', async () => {
  const viewer = new ConversationViewer({});
  const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
  const entry = { session, convo: { messages: [] }, title: 'T', folder: 'F' };

  lastOpenedExternal = null;
  lastCommand = null;
  await viewer.onMessage(entry, { type: 'openLink', href: 'https://example.com/docs' });
  assert.deepStrictEqual(lastOpenedExternal, { value: 'https://example.com/docs' });
  assert.strictEqual(lastCommand, null);

  lastOpenedExternal = null;
  await viewer.onMessage(entry, { type: 'openLink', href: 'notes/demo.md' });
  assert.strictEqual(lastOpenedExternal, null);
  assert.strictEqual(lastCommand.command, 'vscode.open');
  assert.strictEqual(lastCommand.uri.fsPath, path.join(tmp, 'notes', 'demo.md'));
});

test('openAttachment decodes one image on demand and opens it in VS Code', async () => {
  const viewer = new ConversationViewer({});
  const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
  const entry = {
    session,
    convo: {
      messages: [],
      attachmentsById: {
        'att-1': {
          id: 'att-1',
          kind: 'image',
          mediaType: 'image/png',
          data: Buffer.from('fake image bytes').toString('base64'),
        },
      },
    },
    title: 'T',
    folder: 'F',
  };

  lastCommand = null;
  await viewer.onMessage(entry, { type: 'openAttachment', id: 'att-1' });
  assert.strictEqual(lastCommand.command, 'vscode.open');
  assert.match(lastCommand.uri.fsPath, /claude-sessions-viewer/);
  assert.strictEqual(fs.readFileSync(lastCommand.uri.fsPath, 'utf8'), 'fake image bytes');
});

test('generated webview script is valid JavaScript', () => {
  const viewer = new ConversationViewer({});
  const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
  const html = viewer.html({
    session,
    convo: {
      firstTs: '2026-01-01T10:00:00Z',
      lastTs: '2026-01-01T10:00:05Z',
      messages: [{ role: 'user', text: 'hello https://example.com', ts: '2026-01-01T10:00:00Z' }],
    },
    title: 'T',
    folder: 'F',
  });
  const script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/);
  assert.ok(script, 'webview script found');
  assert.doesNotThrow(() => new vm.Script(script[1]));
});

test('generated HTML contains the Short/Full toggle and line-clamp CSS, no scan-row markup', () => {
  const viewer = new ConversationViewer({});
  const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
  const html = viewer.html({
    session,
    convo: {
      firstTs: '2026-01-01T10:00:00Z',
      lastTs: '2026-01-01T10:00:05Z',
      messages: [{ role: 'user', text: 'hello', ts: '2026-01-01T10:00:00Z' }],
    },
    title: 'T',
    folder: 'F',
  });
  assert.match(html, /data-d="short"/);
  assert.match(html, /data-d="full"/);
  assert.match(html, /-webkit-line-clamp:var\(--fold-lines, 4\)/);
  assert.match(html, /max-height:calc\(var\(--fold-lines, 4\) \* 1\.52em\)/,
    'hard height cap so folded code blocks stay clamped');
  assert.match(html, /data-density="short"/, 'default density is short');
  assert.match(html, /--fold-lines:4/, 'default preview length is 4 lines');
  assert.doesNotMatch(html, /\.row-text/);
  assert.doesNotMatch(html, /\.row-time/);
  assert.doesNotMatch(html, /id="moreBtn"|id="moreMenu"|mmCopy|mmExport|mmCopyPath|mmReveal/,
    'viewer keeps raw/export/copy actions out of the main surface');
});

test('generated HTML uses the approved speaker palettes and keeps orange as the Claude identity accent', () => {
  const viewer = new ConversationViewer({});
  const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
  const html = viewer.html({
    session,
    convo: {
      firstTs: '2026-01-01T10:00:00Z',
      lastTs: '2026-01-01T10:00:05Z',
      messages: [
        { role: 'user', text: 'inspect `source_path`', ts: '2026-01-01T10:00:00Z' },
        { role: 'assistant', text: 'working', ts: '2026-01-01T10:00:05Z' },
      ],
    },
    title: 'T',
    folder: 'F',
  });

  assert.match(html, /--user-bub:#e8f0f5; --user-edge:#5b7c8f; --user-strong:#456579/);
  assert.match(html, /--agent-bub:#ececf7; --agent-edge:#6865a5; --agent-strong:#55518f/);
  assert.match(html, /--claude-spark:#d97757/);
  assert.match(html, /"mascotUri":"mascot\.png"/, 'viewer exposes the mascot to rendered Claude messages');
  assert.match(html, /escAttr\(DATA\.mascotUri\)/, 'Claude role marker uses the mascot image');
  assert.match(html, /\.msg\.assistant \{[^}]*border-left:3px solid var\(--agent-edge\)/);
  assert.match(html, /\.msg\.user \{[^}]*border-right:3px solid var\(--user-edge\)/);
  assert.match(html, /\.msg\.assistant \.role-icon \{ color:var\(--claude-spark\); \}/);
  assert.match(html, /\.msg\.user code\.inline \{ color:var\(--user-strong\); \}/);
});

test('filter chips use the configured names in All, Agent, User order without forcing Me or uppercase', () => {
  const origGetConfiguration = fakeVscode.workspace.getConfiguration;
  fakeVscode.workspace.getConfiguration = () => ({
    get: (key, fallback) => ({
      userLabel: 'Yury',
      agentLabel: 'Clone',
      showNames: true,
      theme: 'system',
      viewerDensity: 'short',
    }[key] ?? fallback),
  });
  try {
    const viewer = new ConversationViewer({});
    const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
    const html = viewer.html({
      session,
      convo: {
        firstTs: '2026-01-01T10:00:00Z',
        lastTs: '2026-01-01T10:00:05Z',
        messages: [
          { role: 'user', text: 'hello', ts: '2026-01-01T10:00:00Z' },
          { role: 'assistant', text: 'hi', ts: '2026-01-01T10:00:05Z' },
        ],
      },
      title: 'T',
      folder: 'F',
    });
    const filterMarkup = html.match(/<div class="segmented" id="filterSeg">([\s\S]*?)<\/div>/)[1];
    const labelsFn = html.match(/function labels\(\) \{([\s\S]*?)\n\}/)[1];
    assert.match(filterMarkup, /data-f="all">All<\/button>\s*<button class="seg" data-f="assistant" id="chipAgent">Clone<\/button>\s*<button class="seg" data-f="user" id="chipUser">Yury<\/button>/);
    assert.doesNotMatch(filterMarkup, />Me<\/button>/);
    assert.match(labelsFn, /user: DATA\.userLabel \|\| 'USER'/);
    assert.doesNotMatch(labelsFn, /\.toUpperCase\(\)/);
  } finally {
    fakeVscode.workspace.getConfiguration = origGetConfiguration;
  }
});

test('escaping-trap regression: no degraded /s+/ regex survives the template literal', () => {
  // v1.12.0 wrote replace(/\s+/g, ' ') inside the embedded webview template
  // literal without doubling the backslash. Template literals silently turn
  // \s into s, so the browser received replace(/s+/g, ' ') and every letter
  // "s" vanished from Scan previews. Scan is gone, but this guards against
  // the same escaping mistake recurring anywhere in the generated script.
  const viewer = new ConversationViewer({});
  const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
  const html = viewer.html({
    session,
    convo: {
      firstTs: '2026-01-01T10:00:00Z',
      lastTs: '2026-01-01T10:00:05Z',
      messages: [{ role: 'user', text: 'hello world', ts: '2026-01-01T10:00:00Z' }],
    },
    title: 'T',
    folder: 'F',
  });
  const script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];
  assert.doesNotMatch(script, /\/s\+\//);
  assert.doesNotMatch(script, /replace\(\/s\+\//);
});

test('turn-merge, unified fold, and draggable rail are present in the generated page', () => {
  // Bubbles are built at runtime by the webview script, so these are
  // source-level invariants; the interactive behavior is verified in a real
  // browser via tools/verify-viewer-browser.js (local, not CI).
  const viewer = new ConversationViewer({});
  const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
  const html = viewer.html({
    session,
    convo: {
      firstTs: '2026-01-01T10:00:00Z',
      lastTs: '2026-01-01T10:00:05Z',
      messages: [{ role: 'user', text: 'hello', ts: '2026-01-01T10:00:00Z' }],
    },
    title: 'T',
    folder: 'F',
  });
  const script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1];

  // Turn-merge: the grouping rule (consecutive assistant messages join the
  // previous group) exists and bubbles are assembled from parts.
  assert.match(script, /prev\.role === 'assistant' && m\.role === 'assistant'/);
  assert.match(script, /class="part" data-i=/);
  assert.match(script, /part-sep/);

  // Unified fold: one mechanism — per-bubble overrides against the mode
  // default, a visible chevron on every bubble, and NO Read more anywhere.
  assert.match(script, /overrides/);
  assert.match(script, /fold-ind/);
  assert.doesNotMatch(script, /Read more/);
  assert.doesNotMatch(script, /Show less/);
  assert.match(html, /\.msg\.folded \.bodywrap/);

  // Bold renders as <strong> (the **asterisks** bug).
  assert.match(script, /<strong>/);

  // Draggable rail is the single scroll affordance.
  assert.match(html, /id="rail"/);
  assert.match(script, /setPointerCapture/);
  assert.match(html, /\.chat::-webkit-scrollbar \{ width:0; height:0; \}/);
});

test('a <script> payload inside message text renders escaped, not as a live tag', () => {
  const viewer = new ConversationViewer({});
  const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
  const html = viewer.html({
    session,
    convo: {
      firstTs: '2026-01-01T10:00:00Z',
      lastTs: '2026-01-01T10:00:05Z',
      messages: [{ role: 'user', text: '<script>alert(1)</script>', ts: '2026-01-01T10:00:00Z' }],
    },
    title: 'T',
    folder: 'F',
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  // The `<` in every '<' the data blob is escaped to a unicode literal so no
  // tag (open or close) can ever start there — the payload's `<script>` and
  // `</script>` both start with `<`, not a raw `<`.
  assert.match(html, /\\u003cscript>alert\(1\)\\u003c\/script>/);
});

test('setConfig persists viewerDensity full/short, ignores scan/read/bogus', async () => {
  const viewer = new ConversationViewer({});
  const updates = [];
  const origGetConfiguration = fakeVscode.workspace.getConfiguration;
  fakeVscode.workspace.getConfiguration = () => ({
    get: (k, d) => d,
    update: (key, value) => { updates.push([key, value]); },
  });
  try {
    const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
    const entry = { session, convo: { messages: [] }, title: 'T', folder: 'F' };

    await viewer.onMessage(entry, { type: 'setConfig', viewerDensity: 'short' });
    assert.deepStrictEqual(updates.find((u) => u[0] === 'viewerDensity'), ['viewerDensity', 'short']);

    updates.length = 0;
    await viewer.onMessage(entry, { type: 'setConfig', viewerDensity: 'full' });
    assert.deepStrictEqual(updates.find((u) => u[0] === 'viewerDensity'), ['viewerDensity', 'full']);

    for (const rejected of ['scan', 'read', 'bogus']) {
      updates.length = 0;
      await viewer.onMessage(entry, { type: 'setConfig', viewerDensity: rejected });
      assert.strictEqual(updates.find((u) => u[0] === 'viewerDensity'), undefined, `should ignore '${rejected}'`);
    }
  } finally {
    fakeVscode.workspace.getConfiguration = origGetConfiguration;
  }
});

test('webview locks page scroll so header controls stay visible', () => {
  const viewer = new ConversationViewer({});
  const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
  const html = viewer.html({
    session,
    convo: {
      firstTs: '2026-01-01T10:00:00Z',
      lastTs: '2026-01-01T10:00:05Z',
      messages: [{ role: 'user', text: 'hello', ts: '2026-01-01T10:00:00Z' }],
    },
    title: 'T',
    folder: 'F',
  });

  assert.match(html, /html \{ height:100%; overflow:hidden; \}/);
  assert.match(html, /body \{[^}]*height:100%; overflow:hidden;/);
  assert.match(html, /\.viewer \{[^}]*height:100%; max-height:100%; overflow:hidden;/);
  assert.match(html, /\.chat \{[^}]*overflow-y:auto;/);
});
