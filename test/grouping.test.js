// Invariants of the two tree modes:
//   folders A-Z    — one row per folder, alphabetical, sessions newest-first.
//   timeline       — FLAT list of sessions, newest first, across all folders;
//                    no folder wrapper rows; each node carries its folder.
// These pin the failure modes of earlier implementations: duplicated rows,
// order/liveness contradictions, unstable ids, and lost interleaving.

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
  Uri: { joinPath(...parts) { return { parts }; }, file() { return {}; } },
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { One: 1, Beside: -2 },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return fakeVscode;
  return origLoad.call(this, request, ...rest);
};

const { SessionTreeProvider } = require('../extension');

const fakeContext = (state = {}) => ({
  globalState: { get: (k, d) => (k in state ? state[k] : d), update() {} },
  globalStorageUri: { fsPath: '/tmp/x' },
  extensionUri: 'extension-root',
});

const S = (id, folder, effTs) => ({
  id,
  cwd: `/home/u/${folder}`,
  lastTs: effTs,
  effTs,
  mtimeMs: Date.parse(effTs),
});

// Yury's interleaving scenario: alpha newest, beta in between, alpha older.
const sessions = [
  S('a1', 'alpha', '2026-07-07T12:00:00.000Z'), // newest overall
  S('a2', 'alpha', '2026-07-07T10:00:00.000Z'),
  S('b1', 'beta',  '2026-07-07T11:00:00.000Z'), // between a1 and a2
  S('b2', 'beta',  '2026-07-06T09:00:00.000Z'),
  S('c1', 'gamma', '2026-07-05T08:00:00.000Z'),
];

test('timeline: flat, strictly newest-first, interleaving preserved', () => {
  const p = new SessionTreeProvider(fakeContext());
  const nodes = p.buildTimeline(sessions, null);

  assert.deepStrictEqual(
    nodes.map((n) => n.session.id),
    ['a1', 'b1', 'a2', 'b2', 'c1'],
    'the exact order of work across folders (alpha, beta, alpha again)'
  );
  assert.ok(nodes.every((n) => n.kind === 'session'), 'no folder wrapper rows');
  assert.deepStrictEqual(
    nodes.map((n) => n.group.label),
    ['alpha', 'beta', 'alpha', 'beta', 'gamma'],
    'every row knows its folder (the jump-to-place anchor)'
  );
  assert.strictEqual(new Set(nodes.map((n) => n.session.id)).size, nodes.length, 'no duplicated sessions');
});

test('timeline: a live session with a stale content clock is first', () => {
  const liveStale = {
    id: 'stale-live', cwd: '/home/u/gamma',
    lastTs: '2026-07-01T00:00:00.000Z',
    effTs: '2026-07-07T13:00:00.000Z',
    mtimeMs: Date.parse('2026-07-07T13:00:00.000Z'),
  };
  const p = new SessionTreeProvider(fakeContext());
  const nodes = p.buildTimeline([...sessions, liveStale], null);
  assert.strictEqual(nodes[0].session.id, 'stale-live');
});

test('folders A-Z unchanged: alphabetical, one row per folder, newest-first inside', () => {
  const p = new SessionTreeProvider(fakeContext());
  const groups = p.buildFolderGroups(sessions, null);
  assert.deepStrictEqual(groups.map((g) => g.label), ['alpha', 'beta', 'gamma']);
  assert.strictEqual(new Set(groups.map((g) => g.folderPath)).size, groups.length, 'no folder appears twice');
  assert.deepStrictEqual(groups[0].sessions.map((s) => s.id), ['a1', 'a2']);
  for (const g of groups) assert.match(g.id, /^f:\//, 'path-based, refresh-stable ids');
});

test('mode switching: allSessions and getParent follow the active mode', () => {
  const p = new SessionTreeProvider(fakeContext());
  p.groups = p.buildFolderGroups(sessions, null);
  p.timeline = p.buildTimeline(sessions, null);

  p.treeMode = 'chronological';
  assert.strictEqual(p.allSessions().length, 5);
  assert.strictEqual(p.getParent(p.allSessions()[0]), null, 'timeline sessions are root-level');

  p.treeMode = 'folders';
  assert.strictEqual(p.allSessions().length, 5);
  const parent = p.getParent(p.allSessions()[0]);
  assert.strictEqual(parent.kind, 'folder', 'folder-mode sessions live under their folder');
});

test('timeline mode falls back to folders when the experimental setting is off', () => {
  const p = new SessionTreeProvider(fakeContext({ treeMode: 'chronological' }));
  assert.strictEqual(p.treeMode, 'folders');
});

test('timeline rows cap long titles and keep folder in the description', () => {
  const p = new SessionTreeProvider(fakeContext());
  p.treeMode = 'chronological';
  const node = p.buildTimeline(
    [
      {
        ...S(
          'long-title',
          'claude-sessions-viewer',
          '2026-07-07T12:00:00.000Z'
        ),
        title: 'This is a very long generated session title that would hide the folder name in a narrow sidebar',
      },
    ],
    null
  )[0];

  const item = p.getTreeItem(node);
  assert.match(item.label, /…$/, 'timeline label truncates the visible title');
  assert.strictEqual(item.description, 'claude-sessions-viewer', 'folder remains in the right-side column');
  assert.match(item.tooltip.value, /\*\*This is a very long generated session title/, 'full title stays in tooltip');
});

test('view title switches between folder and timeline modes', () => {
  const p = new SessionTreeProvider(fakeContext());
  p.view = {};

  p.treeMode = 'folders';
  p.loaded = true;
  p.updateModeUi();
  assert.strictEqual(p.view.title, 'Sessions by Folder');
  assert.strictEqual(p.view.description, 'folders A-Z');

  p.treeMode = 'chronological';
  p.updateModeUi();
  assert.strictEqual(p.view.title, 'Session Timeline');
  assert.strictEqual(p.view.description, 'newest first');
});

test('collapse-all keeps the folder containing the revealed session expanded', () => {
  const p = new SessionTreeProvider(fakeContext({ selectedSessionId: 'b1' }));
  p.groups = p.buildFolderGroups(sessions, null);
  p.expandedAll = false;

  const beta = p.groups.find((g) => g.label === 'beta');
  const gamma = p.groups.find((g) => g.label === 'gamma');

  assert.strictEqual(
    p.getTreeItem({ kind: 'folder', group: beta }).collapsibleState,
    fakeVscode.TreeItemCollapsibleState.Expanded,
    'selected/revealed session folder stays open'
  );
  assert.strictEqual(
    p.getTreeItem({ kind: 'folder', group: gamma }).collapsibleState,
    fakeVscode.TreeItemCollapsibleState.Collapsed,
    'unrelated folders stay collapsed'
  );
});

test('live sessions use the Claude presence icon and highlight their containing folder', () => {
  const live = {
    ...S('live-now', 'active-project', new Date().toISOString()),
    mtimeMs: Date.now(),
  };
  const inactive = {
    ...S('old-session', 'quiet-project', '2026-01-01T00:00:00.000Z'),
    mtimeMs: Date.parse('2026-01-01T00:00:00.000Z'),
  };
  const p = new SessionTreeProvider(fakeContext());
  const groups = p.buildFolderGroups([live, inactive], null);
  const activeGroup = groups.find((g) => g.label === 'active-project');
  const quietGroup = groups.find((g) => g.label === 'quiet-project');

  const activeFolderItem = p.getTreeItem({ kind: 'folder', group: activeGroup });
  const quietFolderItem = p.getTreeItem({ kind: 'folder', group: quietGroup });
  assert.strictEqual(activeFolderItem.iconPath.parts.at(-1), 'folder-active.svg');
  assert.strictEqual(quietFolderItem.iconPath.parts.at(-1), 'folder-spark.svg');

  const liveSessionItem = p.getTreeItem({ kind: 'session', session: live, group: activeGroup });
  const inactiveSessionItem = p.getTreeItem({ kind: 'session', session: inactive, group: quietGroup });
  assert.strictEqual(liveSessionItem.iconPath.parts.at(-1), 'session-active.svg');
  assert.strictEqual(inactiveSessionItem.iconPath, undefined);
  assert.doesNotMatch(liveSessionItem.label, /●/, 'the Claude icon replaces the generic live dot');
});
