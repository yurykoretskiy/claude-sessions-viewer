// #codex
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { indexAll } = require('../indexer');

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

test('Claude activity follows message timestamps and per-message cwd, not file mtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-activity-'));
  dirs.push(root);
  const project = path.join(root, 'encoded-project');
  fs.mkdirSync(project);
  const file = path.join(project, '11111111-2222-4333-8444-555555555555.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-07-18T08:01:00Z', cwd: '/work/alpha', message: { content: 'Work in alpha' } },
    { type: 'assistant', timestamp: '2026-07-18T08:02:00Z', cwd: '/work/alpha', message: { content: [{ type: 'tool_use', name: 'Edit' }] } },
    { type: 'user', timestamp: '2026-07-19T09:01:00Z', cwd: '/work/beta', message: { content: 'Work in beta' } },
    { type: 'ai-title', aiTitle: 'Touched later without work' },
  ];
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  fs.utimesSync(file, new Date('2026-07-20T12:00:00Z'), new Date('2026-07-20T12:00:00Z'));

  const [session] = await indexAll(path.join(root, 'cache.json'), null, {
    projectsDir: root,
    includePrompts: false,
  });
  assert.strictEqual(session.activityTs, '2026-07-19T09:01:00Z');
  assert.deepStrictEqual(session.activities, [
    { ts: '2026-07-18T08:02:00Z', cwd: '/work/alpha' },
    { ts: '2026-07-19T09:01:00Z', cwd: '/work/beta' },
  ]);
  assert.strictEqual(session.effTs, '2026-07-20T12:00:00.000Z');
});
