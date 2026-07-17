const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const calls = [];
const messages = [];
const fakeVscode = {
  workspace: { workspaceFolders: [] },
  extensions: { getExtension: () => ({ id: 'anthropic.claude-code' }) },
  commands: {
    async executeCommand(...args) {
      calls.push(args);
    },
  },
  window: {
    showErrorMessage(message) { messages.push(message); },
    showWarningMessage(message) { messages.push(message); },
  },
  Uri: { file(fsPath) { return { fsPath }; } },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, ...rest);
};

const { openClaudeCodePanel, openSessionInClaudeCode } = require('../extension');
Module._load = originalLoad;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-launch-'));
const current = path.join(tmp, 'current');
const other = path.join(tmp, 'other');
fs.mkdirSync(current);
fs.mkdirSync(other);

const session = (cwd) => ({
  id: '11111111-2222-4333-8444-555555555555',
  cwd,
});

beforeEach(() => {
  calls.length = 0;
  messages.length = 0;
  fakeVscode.workspace.workspaceFolders = [{ uri: { fsPath: current } }];
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('official Claude Code launch passes the exact session id', async () => {
  const ok = await openClaudeCodePanel(session(current).id);
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(calls, [[
    'claude-vscode.primaryEditor.open',
    session(current).id,
    undefined,
  ]]);
});

test('same-workspace session opens in Claude Code without opening another window', async () => {
  const flagFile = path.join(tmp, 'same-window-flag.json');
  const ok = await openSessionInClaudeCode(session(path.join(current, 'nested')), flagFile);
  assert.strictEqual(ok, false, 'missing nested cwd is rejected before launch');

  const okExisting = await openSessionInClaudeCode(session(current), flagFile);
  assert.strictEqual(okExisting, true);
  assert.strictEqual(fs.existsSync(flagFile), false);
  assert.deepStrictEqual(calls.at(-1), [
    'claude-vscode.primaryEditor.open',
    session(current).id,
    undefined,
  ]);
});

test('other-workspace session records the id and opens its folder in a new window', async () => {
  const flagFile = path.join(tmp, 'global-storage', 'open-panel-flag.json');
  const ok = await openSessionInClaudeCode(session(other), flagFile);
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(flagFile, 'utf8')), {
    action: 'resume',
    folder: other,
    sessionId: session(other).id,
    ts: JSON.parse(fs.readFileSync(flagFile, 'utf8')).ts,
  });
  assert.deepStrictEqual(calls.at(-1), [
    'vscode.openFolder',
    { fsPath: other },
    { forceNewWindow: true },
  ]);
});

test('invalid session id never reaches the official extension command', async () => {
  const ok = await openClaudeCodePanel('not-a-session-id');
  assert.strictEqual(ok, false);
  assert.strictEqual(calls.length, 0);
  assert.match(messages[0], /not a valid UUID/);
});
