// #codex
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const vm = require('node:vm');

const fakeVscode = {
  Uri: { joinPath: (...parts) => ({ parts }) },
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, ...rest);
};
const { SessionsWebviewProvider, normalizeSessions, sessionActivities, SESSION_CAP } = require('../sessions-view');
Module._load = originalLoad;

const claudeProvider = {
  workspaceRoot: null,
  folderForSession(session) {
    return { folderPath: session.cwd, label: session.cwd.split('/').pop() };
  },
  displayTitle(session) { return session.title; },
};

test('combined sessions normalize to one newest-first source-aware list', () => {
  const sessions = normalizeSessions(
    claudeProvider,
    [{ id: 'c1', title: 'Claude', cwd: '/work/a', file: '/c1', activities: [{ ts: '2026-07-19T10:00:00Z', cwd: '/work/a' }] }],
    [{ id: 'x1', title: 'Codex', cwd: '/work/b', file: '/x1', activities: [{ ts: '2026-07-19T11:00:00Z', cwd: '/work/b' }], source: 'codex' }]
  );
  assert.deepStrictEqual(sessions.map((session) => session.key), ['codex:x1', 'claude:c1']);
  assert.deepStrictEqual(sessions.map((session) => session.folderLabel), ['b', 'a']);
});

test('mtime-only sessions are excluded and one session can retain several project-day activities', () => {
  assert.deepStrictEqual(sessionActivities({ cwd: '/work/a', mtimeMs: Date.now() }), []);
  const activities = sessionActivities({
    cwd: '/work/a',
    mtimeMs: Date.now(),
    activities: [
      { ts: '2026-07-18T23:00:00Z', cwd: '/work/a' },
      { ts: '2026-07-19T09:00:00Z', cwd: '/work/b' },
    ],
  });
  assert.deepStrictEqual(activities.map((item) => item.cwd), ['/work/a', '/work/b']);
});

test('same project basenames receive parent-path disambiguation', () => {
  const sessions = normalizeSessions(
    claudeProvider,
    [
      { id: 'a', title: 'A', file: '/a', activities: [{ ts: '2026-07-19T10:00:00Z', cwd: '/first/place-pulse' }] },
      { id: 'b', title: 'B', file: '/b', activities: [{ ts: '2026-07-19T11:00:00Z', cwd: '/second/place-pulse' }] },
    ],
    []
  );
  assert.ok(sessions.every((session) => session.folderHint));
  assert.notStrictEqual(sessions[0].folderHint, sessions[1].folderHint);
});

test('sidebar HTML has only approved grouping/source controls and four row actions', () => {
  const context = { extensionUri: 'extension-root', globalStorageUri: { fsPath: '/tmp' }, subscriptions: [] };
  const provider = new SessionsWebviewProvider(context, claudeProvider);
  const webview = {
    cspSource: 'vscode-webview:',
    asWebviewUri(uri) { return { toString: () => `asset:${uri.parts.at(-1)}` }; },
  };
  const html = provider.html(webview);

  assert.match(html, />Date<\/button>/);
  assert.match(html, />Folder<\/button>/);
  assert.match(html, />All<\/button>/);
  assert.match(html, />Claude<\/button>/);
  assert.match(html, />Codex<\/button>/);
  assert.doesNotMatch(html, />Model<|Status|Environment|Sort by|In one list/i);
  for (const action of ['open', 'official', 'resume', 'copy']) {
    assert.match(html, new RegExp(`actionButton\\('${action}'`));
  }
  assert.strictEqual(SESSION_CAP, 10);
  assert.doesNotMatch(html, /showFolders|folderToggle/);
  assert.match(html, /renderDate[\s\S]*projectGroups/);
  assert.match(html, /Archived locations/);
  assert.match(html, /tree-open-preview-dark\.svg/);
  assert.match(html, /tree-terminal-dark\.svg/);
  assert.match(html, /tree-copy-dark\.svg/);
  assert.match(html, /SESSION VIEWER/);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
});
