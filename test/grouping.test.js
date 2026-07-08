// Invariants of the two tree modes. The "Recent" mode is the same folder
// tree as A-Z, re-ordered — one row per folder, newest activity on top.
// These tests pin the exact failure modes of earlier implementations:
// duplicated folder rows, order/liveness contradictions, and unstable ids.

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fakeVscode = {
  window: {
    createStatusBarItem: () => ({ show() {}, hide() {} }),
    createTreeView() {},
    setStatusBarMessage() {},
    showInformationMessage() {},
    showWarningMessage() {},
    showErrorMessage() {},
    createTerminal: () => ({ show() {}, sendText() {} }),
  },
  workspace: { getConfiguration: () => ({ get: (k, d) => d }), workspaceFolders: null, onDidChangeConfiguration() {} },
  commands: { executeCommand() {}, registerCommand() {} },
  EventEmitter: class { constructor() { this.event = () => {}; } fire() {} },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {},
  MarkdownString: class { constructor(s) { this.value = s; } },
  Uri: { joinPath() { return {}; }, file() { return {}; } },
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { One: 1, Beside: -2 },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return fakeVscode;
  return origLoad.call(this, request, ...rest);
};

const { SessionTreeProvider } = require('../extension');

const fakeContext = () => ({
  globalState: { get: (k, d) => d, update() {} },
  globalStorageUri: { fsPath: '/tmp/x' },
});

const S = (id, folder, effTs) => ({
  id,
  cwd: `/home/u/${folder}`,
  lastTs: effTs,
  effTs,
  mtimeMs: Date.parse(effTs),
});

// Yury's interleaving scenario: A, A (newest), then B in between, then A older.
const sessions = [
  S('a1', 'alpha', '2026-07-07T12:00:00.000Z'), // newest overall
  S('a2', 'alpha', '2026-07-07T10:00:00.000Z'),
  S('b1', 'beta',  '2026-07-07T11:00:00.000Z'), // between a1 and a2
  S('b2', 'beta',  '2026-07-06T09:00:00.000Z'),
  S('c1', 'gamma', '2026-07-05T08:00:00.000Z'),
];

test('recent mode: one row per folder, newest folder first (interleaving collapses cleanly)', () => {
  const p = new SessionTreeProvider(fakeContext());
  const groups = p.buildRecentGroups(sessions, null);

  const labels = groups.map((g) => g.label);
  assert.deepStrictEqual(labels, ['alpha', 'beta', 'gamma'], 'ordered by newest activity');

  const unique = new Set(groups.map((g) => g.folderPath));
  assert.strictEqual(unique.size, groups.length, 'NO folder appears twice');

  assert.deepStrictEqual(groups[0].sessions.map((s) => s.id), ['a1', 'a2'], 'sessions newest-first inside');
  assert.strictEqual(groups[0].latest, '2026-07-07T12:00:00.000Z');
});

test('a-z mode unchanged: alphabetical folders, newest-first inside', () => {
  const p = new SessionTreeProvider(fakeContext());
  const groups = p.buildFolderGroups(sessions, null);
  assert.deepStrictEqual(groups.map((g) => g.label), ['alpha', 'beta', 'gamma']);
});

test('recent mode: a live session with a stale content clock lifts its folder to the top', () => {
  const liveStale = {
    id: 'stale-live', cwd: '/home/u/gamma',
    lastTs: '2026-07-01T00:00:00.000Z',            // content clock: old
    effTs: '2026-07-07T13:00:00.000Z',             // activity: now (mtime)
    mtimeMs: Date.parse('2026-07-07T13:00:00.000Z'),
  };
  const p = new SessionTreeProvider(fakeContext());
  const groups = p.buildRecentGroups([...sessions, liveStale], null);
  assert.strictEqual(groups[0].label, 'gamma', 'being-written-now session promotes its folder');
  assert.strictEqual(groups[0].sessions[0].id, 'stale-live');
});

test('group ids are identical in both modes and refresh-stable (expansion survives toggling)', () => {
  const p = new SessionTreeProvider(fakeContext());
  const az = p.buildFolderGroups(sessions, null);
  const recent1 = p.buildRecentGroups(sessions, null);
  const recent2 = p.buildRecentGroups([...sessions].reverse(), null);

  const idsOf = (gs) => new Set(gs.map((g) => g.id));
  assert.deepStrictEqual(idsOf(recent1), idsOf(az), 'same ids across modes');
  assert.deepStrictEqual(idsOf(recent2), idsOf(recent1), 'same ids regardless of input order');
  for (const g of [...az, ...recent1]) {
    assert.match(g.id, /^f:\//, 'ids are path-based, never positional');
  }
});
