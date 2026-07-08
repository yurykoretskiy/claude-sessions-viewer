// Viewer behavior tests with a stubbed vscode API:
// 1. Rapid concurrent open() calls (double-click) create exactly ONE panel.
// 2. The resume path refuses non-UUID session ids (they reach a shell).

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
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
