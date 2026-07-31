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
let lastClipboard = null;

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
  env: { clipboard: { writeText(value) { lastClipboard = value; } }, openExternal(uri) { lastOpenedExternal = uri; } },
  commands: { executeCommand(command, uri) { lastCommand = { command, uri }; } },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return fakeVscode;
  return origLoad.call(this, request, ...rest);
};

const { ConversationViewer, extractMessageOutputs } = require('../viewer');

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

test('copyMessage copies only the selected readable message parts', async () => {
  const viewer = new ConversationViewer({});
  const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
  const entry = {
    session,
    convo: {
      messages: [
        { role: 'assistant', text: 'First assistant part' },
        { role: 'tool', text: '[tool: Bash]' },
        { role: 'assistant', text: 'Second assistant part' },
      ],
    },
    title: 'T',
    folder: 'F',
  };

  lastClipboard = null;
  await viewer.onMessage(entry, { type: 'copyMessage', indices: [0, 1, 2, 99, -1] });
  assert.strictEqual(lastClipboard, 'First assistant part\n\nSecond assistant part');
});

test('copyOutput copies one complete path or URL', async () => {
  const viewer = new ConversationViewer({});
  const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
  lastClipboard = null;
  await viewer.onMessage(
    { session, convo: { messages: [] }, title: 'T', folder: 'F' },
    { type: 'copyOutput', value: '/tmp/demo/report.html' }
  );
  assert.strictEqual(lastClipboard, '/tmp/demo/report.html');
});

test('output extraction recognizes generated artifacts and ignores code files', () => {
  const outputs = extractMessageOutputs([
    'Done: [Conversation mockup](poc/log-view-output-mockup.html)',
    'Sheet: https://docs.google.com/spreadsheets/d/abc123',
    'I also changed viewer.js and package.json.',
    'Duplicate poc/log-view-output-mockup.html',
  ].join('\n'));
  assert.deepStrictEqual(outputs, [
    { kind: 'HTML', title: 'Conversation mockup', href: 'poc/log-view-output-mockup.html' },
    { kind: 'SHEET', title: 'Google Sheets', href: 'https://docs.google.com/spreadsheets/d/abc123' },
  ]);
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

test('generated HTML uses one viewer mode with manual folding and no density toggle', () => {
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
  assert.doesNotMatch(html, /data-d="short"|data-d="full"/);
  assert.match(html, /max-height:calc\(var\(--message-fold-lines, 14\) \* 1\.55em\)/,
    'folded messages use a larger measured preview cap');
  assert.match(html, /--fold-lines:14/, 'default Claude preview length is 14 lines');
  assert.match(html, /return role === 'user' \? 4 : base/, 'user prompts stay compact at four lines');
  assert.match(html, /function syncFoldControls\(\)/, 'long messages use post-layout overflow detection');
  assert.match(html, /scrollHeight > body\.clientHeight/, 'overflow is measured from rendered content');
  assert.match(html, /mask-image:linear-gradient/, 'folded messages fade at the bottom');
  assert.doesNotMatch(html, /id="namesBtn"|id="namesMenu"|id="showNames"/,
    'speaker names are no longer controlled inside the viewer');
  assert.match(html, /id="modelToggle"/);
  assert.doesNotMatch(html, /id="mstrip"|renderModelStrip/,
    'model display is attached to messages instead of a timeline');
  assert.doesNotMatch(html, /data-th=/,
    'theme stays in normal VS Code settings');
  assert.match(html, /id="copyConversation"/);
  assert.match(html, /class="folder-row"[\s\S]*class="folder-label"[\s\S]*class="header-actions"[\s\S]*id="revealInTree"[\s\S]*id="openClaudeCode"[\s\S]*id="resumeTerminal"[\s\S]*id="refreshViewer"/,
    'the folder row keeps reveal, Claude Code, terminal, and refresh actions in order');
  assert.doesNotMatch(html, /<div class="controls">[\s\S]*id="refreshViewer"/,
    'refresh is no longer mixed into the conversation filter row');
  assert.match(html, /\.folder-label \{[^}]*flex:1 1 auto;[^}]*min-width:0;/,
    'the folder name shrinks before the action group');
  assert.match(html, /\.header-actions \{[^}]*gap:0;[^}]*flex:0 0 auto;/,
    'header actions stay grouped and never shrink');
  assert.match(html, /type:'refresh'/);
  assert.match(html, /id="fontDown"/);
  assert.match(html, /id="fontUp"/);
  assert.match(html, /setReaderScale/);
  assert.match(html, /--reader-scale/);
  assert.match(html, /function setFilter\(nextFilter\)/,
    'filter changes use a stable DOM path');
  assert.match(html, /function applyFilterVisibility\(\)/);
  assert.match(html, /filterAnchors/);
  assert.doesNotMatch(html, /b\.classList\.add\('on'\); filter = b\.dataset\.f; currentMatch = 0; render\(true\)/,
    'filter changes do not rebuild the conversation');
  assert.doesNotMatch(html, /id="resume"/, 'viewer header no longer contains a terminal runner');
  assert.match(html, /class="folder-label"/);
  assert.match(html, /folderIconUri|class="folder-label"[^>]*>\s*<img/, 'viewer header carries the folder symbol');
  assert.match(html, /footer-hidden/);
  assert.match(html, /classList\.toggle\('footer-visible'\)/);
  assert.doesNotMatch(html, /showFooter|render\(true\);\s*\n?\s*};\s*\n?\s*\$\('jump'/,
    'footer visibility does not use a render pass');
  assert.match(html, /class="msg-copy"/);
  assert.match(html, /\.msg-copy \{ position:absolute; bottom:-8px/,
    'message copy is attached without reserving another layout row');
  assert.match(html, /type:'copyMessage'/);
  assert.doesNotMatch(html, /\.row-text/);
  assert.doesNotMatch(html, /\.row-time/);
  assert.doesNotMatch(html, /id="moreBtn"|id="moreMenu"|mmCopy|mmExport|mmCopyPath|mmReveal/,
    'viewer keeps raw/export/copy actions out of the main surface');
});

test('viewer header actions delegate to reveal, Claude Code, and terminal behavior', async () => {
  const viewer = new ConversationViewer({});
  const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
  const entry = { session, convo: { messages: [] }, title: 'T', folder: 'F' };

  lastCommand = null;
  await viewer.onMessage(entry, { type: 'revealInTree' });
  assert.deepStrictEqual(lastCommand, {
    command: 'claudeSessions.revealViewerSession',
    uri: session.id,
  });

  await viewer.onMessage(entry, { type: 'openClaudeCode' });
  assert.deepStrictEqual(lastCommand, {
    command: 'claudeSessions.openViewerInClaudeCode',
    uri: session,
  });

  terminalsCreated = 0;
  await viewer.onMessage(entry, { type: 'resume' });
  assert.strictEqual(terminalsCreated, 1, 'terminal action resumes the exact session');
});

test('generated HTML uses the narrow reading geometry and Claude identity accent', () => {
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

  assert.match(html, /\.msg\.user \{ max-width:82%/);
  assert.match(html, /\.msg\.assistant \{ max-width:96%/);
  assert.match(html, /--agent-edge:#c66b4b; --agent-strong:#a95438/);
  assert.match(html, /--claude-spark:#d97757/);
  assert.match(html, /"claudeIconUri":"claude-code-logo-light\.svg"/, 'viewer exposes the Claude favicon for message details');
  assert.match(html, /escAttr\(DATA\.claudeIconUri\)/, 'message details use the Claude favicon');
  assert.match(html, /\.message-footer-avatar/);
  assert.match(html, /CLAUDE.*modelLabel\(m\.model\)/s);
  assert.match(html, /\.msg\.user code\.inline \{ color:var\(--user-strong\); \}/);
});

test('assistant outputs render outside the fold with narrow responsive controls', () => {
  const viewer = new ConversationViewer({});
  const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
  const html = viewer.html({
    session,
    convo: {
      firstTs: '2026-01-01T10:00:00Z',
      lastTs: '2026-01-01T10:00:05Z',
      messages: [
        { role: 'assistant', text: 'Done: [Mockup](poc/result.html)', ts: '2026-01-01T10:00:05Z' },
      ],
    },
    title: 'T',
    folder: 'F',
  });
  assert.match(html, /function renderOutputs\(indices\)/);
  assert.match(html, /<\/div>' \+ moreButton \+ outputs \+ footer/,
    'output blocks are outside the clamped message body');
  assert.match(html, /data-output-open/);
  assert.match(html, /data-output-copy/);
  assert.match(html, /function outputDisplayName\(output\)/,
    'output rows derive the complete filename from the path');
  assert.match(html, /aria-label="' \+ copyLabel/,
    'output path copying uses a compact icon with an accessible label');
  assert.doesNotMatch(html, /class="output-path"/,
    'the parent path is not duplicated beneath the filename');
  assert.match(html, /\.output-title \{[^}]*overflow-wrap:anywhere/,
    'long filenames wrap instead of losing their version suffix to ellipsis');
  assert.match(html, /\.more \{[^}]*color:var\(--mut\)/,
    'Show more and Show less remain visually secondary');
  assert.match(html, /@media \(max-width:360px\)/);
  assert.match(html, /grid-template-columns:auto minmax\(0,1fr\)/);
});

test('filter chips use the configured names in All, Agent, User order without forcing Me or uppercase', () => {
  const origGetConfiguration = fakeVscode.workspace.getConfiguration;
  fakeVscode.workspace.getConfiguration = () => ({
    get: (key, fallback) => ({
      userLabel: 'Yury',
      agentLabel: 'Clone',
      theme: 'system',
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

  // Progressive disclosure: long bubbles use a per-bubble override and their
  // own Show more / Show less control.
  assert.match(script, /overrides/);
  assert.match(script, /Show more/);
  assert.match(script, /Show less/);
  assert.match(script, /toggleFoldInPlace/);
  assert.doesNotMatch(script, /fold-ind/);
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

test('viewer reads theme from VS Code settings and labels from the viewer configuration source', () => {
  const viewer = new ConversationViewer({});
  const origGetConfiguration = fakeVscode.workspace.getConfiguration;
  fakeVscode.workspace.getConfiguration = () => ({
    get: (key, fallback) => ({
      theme: 'dark',
      userLabel: 'Yury',
      agentLabel: 'Claude',
    }[key] ?? fallback),
  });
  try {
    const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
    const html = viewer.html({
      session,
      convo: { firstTs: null, lastTs: null, messages: [] },
      title: 'T',
      folder: 'F',
    });
    assert.doesNotMatch(html, /data-names=/);
    assert.match(html, /"userLabel":"Yury"/);
    assert.match(html, /"agentLabel":"Claude"/);
    assert.match(html, /"theme":"dark"/);
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

test('viewer heading exposes the complete session title on hover', () => {
  const viewer = new ConversationViewer({});
  const session = { id: '11111111-2222-3333-4444-555555555555', file, cwd: tmp };
  const title = 'A long session title with "quotes" that can be truncated in a narrow panel';
  const html = viewer.html({
    session,
    convo: { firstTs: null, lastTs: null, messages: [] },
    title,
    folder: 'F',
  });

  assert.match(html, /class="title" title="A long session title with &quot;quotes&quot; that can be truncated in a narrow panel"/);
});
