// #codex
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  indexAllCodex,
  extractCodexConversation,
  titleFromMessage,
} = require('../codex-indexer');

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-index-'));
  dirs.push(root);
  const day = path.join(root, '2026', '07', '19');
  fs.mkdirSync(day, { recursive: true });
  return { root, day };
}

function writeRollout(file, events) {
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}

test('title prefers the explicit request over attachment metadata', () => {
  const text = '# Files mentioned by the user:\n\n## screenshot.png: /tmp/screenshot.png\n\n## My request for Codex:\nBuild the combined session view.';
  assert.strictEqual(titleFromMessage(text), 'Build the combined session view.');
});

test('Codex index excludes subagent sidechains and de-duplicates moved copies', async () => {
  const { root, day } = fixture();
  const id = '11111111-2222-4333-8444-555555555555';
  const oldFile = path.join(day, `rollout-old-${id}.jsonl`);
  const newFile = path.join(day, `rollout-new-${id}.jsonl`);
  const subId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const subFile = path.join(day, `rollout-sub-${subId}.jsonl`);
  const mainEvents = (title) => [
    { type: 'session_meta', payload: { id, cwd: '/work/project', timestamp: '2026-07-19T10:00:00Z' } },
    { type: 'event_msg', timestamp: '2026-07-19T10:01:00Z', payload: { type: 'user_message', message: title } },
  ];
  writeRollout(oldFile, mainEvents('Old title'));
  writeRollout(newFile, mainEvents('Newest title'));
  writeRollout(subFile, [
    { type: 'session_meta', payload: { id: subId, cwd: '/work/project', source: { subagent: { other: 'guardian' } } } },
  ]);
  const now = Date.now();
  fs.utimesSync(oldFile, new Date(now - 2000), new Date(now - 2000));
  fs.utimesSync(newFile, new Date(now), new Date(now));

  const sessions = await indexAllCodex(path.join(root, 'cache.json'), root);
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].id, id);
  assert.strictEqual(sessions[0].title, 'Newest title');
  assert.strictEqual(sessions[0].source, 'codex');
});

test('Codex activity follows real messages and turn folders, not a later file touch', async () => {
  const { root, day } = fixture();
  const id = '21111111-2222-4333-8444-555555555555';
  const file = path.join(day, 'rollout-test-' + id + '.jsonl');
  writeRollout(file, [
    { type: 'session_meta', payload: { id, cwd: '/work/alpha', timestamp: '2026-07-18T08:00:00Z' } },
    { type: 'turn_context', payload: { cwd: '/work/alpha' } },
    { type: 'event_msg', timestamp: '2026-07-18T08:01:00Z', payload: { type: 'user_message', message: 'Work in alpha' } },
    { type: 'turn_context', payload: { cwd: '/work/beta' } },
    { type: 'event_msg', timestamp: '2026-07-19T09:02:00Z', payload: { type: 'agent_message', message: 'Work in beta' } },
  ]);
  fs.utimesSync(file, new Date('2026-07-20T12:00:00Z'), new Date('2026-07-20T12:00:00Z'));

  const [session] = await indexAllCodex(path.join(root, 'cache.json'), root);
  assert.strictEqual(session.activityTs, '2026-07-19T09:02:00Z');
  assert.deepStrictEqual(session.activities, [
    { ts: '2026-07-18T08:01:00Z', cwd: '/work/alpha' },
    { ts: '2026-07-19T09:02:00Z', cwd: '/work/beta' },
  ]);
});

test('conversation uses visible event messages and ignores injected response items', async () => {
  const { day } = fixture();
  const id = '11111111-2222-4333-8444-555555555555';
  const file = path.join(day, `rollout-test-${id}.jsonl`);
  writeRollout(file, [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work' }] } },
    { type: 'event_msg', timestamp: '2026-07-19T10:00:00Z', payload: { type: 'user_message', message: 'Real request' } },
    { type: 'event_msg', timestamp: '2026-07-19T10:01:00Z', payload: { type: 'agent_message', message: 'Real answer' } },
  ]);
  const conversation = await extractCodexConversation(file);
  assert.deepStrictEqual(conversation.messages.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: 'Real request' },
    { role: 'assistant', text: 'Real answer' },
  ]);
});
