// Regression guard for the two-clocks bug: a session has a content clock
// (last "timestamp" inside the transcript) and a file clock (mtime). Claude
// Code appends metadata records WITHOUT timestamps after the conversation
// (ai-title, last-prompt, mode), so the content clock can be hours behind a
// file that is being written right now. Sorting/age must use effectiveTs —
// the newer of the two — the same signal as the live ● marker.
// Invariant: a session active NOW is never sorted below an older one.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-effts-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const projDir = path.join(HOME, '.claude', 'projects', '-tmp-demo');
fs.mkdirSync(projDir, { recursive: true });

function writeSession(id, contentTs) {
  const file = path.join(projDir, `${id}.jsonl`);
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'user', cwd: '/tmp/demo', timestamp: contentTs, message: { content: 'hi ' + id } }) + '\n'
  );
  return file;
}

const { indexAll, effectiveTs } = require('../indexer');

test('effectiveTs picks the newer of content timestamp and mtime', () => {
  assert.strictEqual(effectiveTs('2026-01-01T00:00:00Z', Date.parse('2026-01-02T00:00:00Z')), '2026-01-02T00:00:00.000Z');
  assert.strictEqual(effectiveTs('2026-01-03T00:00:00Z', Date.parse('2026-01-02T00:00:00Z')), '2026-01-03T00:00:00.000Z');
  assert.strictEqual(effectiveTs(null, Date.parse('2026-01-02T00:00:00Z')), '2026-01-02T00:00:00.000Z');
  assert.strictEqual(effectiveTs(null, 0), '');
});

test('a live session with a stale content clock sorts above an older session', async () => {
  // "stale" session: conversation timestamps ended long ago, but the file was
  // just written (metadata append) — this is the real Claude Code behavior.
  const staleLive = writeSession('11111111-aaaa-4aaa-8aaa-111111111111', '2026-01-01T00:00:00Z');
  fs.utimesSync(staleLive, new Date(), new Date()); // mtime = now

  // ordinary session: content and mtime both one hour ago
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  const ordinary = writeSession('22222222-bbbb-4bbb-8bbb-222222222222', hourAgo.toISOString());
  fs.utimesSync(ordinary, hourAgo, hourAgo);

  const sessions = await indexAll(path.join(HOME, 'storage', 'cache.json'), undefined, { includePrompts: false });
  assert.strictEqual(sessions.length, 2);

  const sorted = [...sessions].sort((a, b) => (b.effTs || '').localeCompare(a.effTs || ''));
  assert.strictEqual(sorted[0].id, '11111111-aaaa-4aaa-8aaa-111111111111',
    'the being-written-now session must sort first even though its content timestamps are old');

  const stale = sessions.find((s) => s.id.startsWith('11111111'));
  assert.ok(Date.parse(stale.effTs) > Date.now() - 60_000, 'effTs reflects the fresh mtime');
  assert.ok(stale.lastTs.startsWith('2026-01-01'), 'content clock still preserved separately');
});

test('automation classifier: sdk entrypoints are automation, interactive/missing are not', () => {
  const { isAutomationSession } = require('../indexer');
  assert.strictEqual(isAutomationSession({ entrypoint: 'sdk-py' }), true);
  assert.strictEqual(isAutomationSession({ entrypoint: 'sdk-cli' }), true);
  assert.strictEqual(isAutomationSession({ entrypoint: 'claude-vscode' }), false);
  assert.strictEqual(isAutomationSession({ entrypoint: 'cli' }), false);
  assert.strictEqual(isAutomationSession({}), false, 'old transcripts without the field stay visible');
});

test('indexer extracts the entrypoint field', async () => {
  const file = path.join(projDir, '33333333-cccc-4ccc-8ccc-333333333333.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'user', cwd: '/tmp/demo', entrypoint: 'sdk-py', timestamp: '2026-01-05T00:00:00Z', message: { content: 'auto' } }) + '\n'
  );
  const sessions = await indexAll(path.join(HOME, 'storage', 'cache2.json'), undefined, { includePrompts: false });
  const auto = sessions.find((s) => s.id.startsWith('33333333'));
  assert.strictEqual(auto.entrypoint, 'sdk-py');
})
