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
  Uri: {
    file(fsPath) {
      const uri = { fsPath };
      Object.defineProperty(uri, 'with', {
        enumerable: false,
        value(change) { return { fsPath, ...change }; },
      });
      return uri;
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, ...rest);
};

const { openClaudeCodePanel, openCodexPanel, openNewClaudeCodeInFolder, openSessionInClaudeCode } = require('../extension');
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

test('official Codex launch opens the exact custom-editor route', async () => {
  const id = session(current).id;
  const ok = await openCodexPanel(id);
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(calls, [[
    'vscode.openWith',
    { fsPath: `/local/${id}`, scheme: 'openai-codex', authority: 'route' },
    'chatgpt.conversationEditor',
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

test('No project session opens directly without mounting the home directory', async () => {
  const flagFile = path.join(tmp, 'home-window-flag.json');
  const ok = await openSessionInClaudeCode(session(os.homedir()), flagFile);
  assert.strictEqual(ok, true);
  assert.strictEqual(fs.existsSync(flagFile), false);
  assert.deepStrictEqual(calls, [[
    'claude-vscode.primaryEditor.open',
    session(os.homedir()).id,
    undefined,
  ]]);
});

test('new Claude Code conversation reuses the current workspace window', async () => {
  const flagFile = path.join(tmp, 'new-current-window-flag.json');
  const ok = await openNewClaudeCodeInFolder(current, flagFile);
  assert.strictEqual(ok, true);
  assert.strictEqual(fs.existsSync(flagFile), false);
  assert.deepStrictEqual(calls, [['claude-vscode.newConversation']]);
});

test('new Claude Code conversation opens another folder in a new window', async () => {
  const flagFile = path.join(tmp, 'new-other-window', 'open-panel-flag.json');
  const ok = await openNewClaudeCodeInFolder(other, flagFile);
  assert.strictEqual(ok, true);
  const flag = JSON.parse(fs.readFileSync(flagFile, 'utf8'));
  assert.strictEqual(flag.action, 'new');
  assert.strictEqual(flag.folder, other);
  assert.ok(Number.isFinite(flag.ts));
  assert.deepStrictEqual(calls.at(-1), [
    'vscode.openFolder',
    { fsPath: other },
    { forceNewWindow: true },
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
