const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractConversation, computeModelRuns } = require('../conversation');

function writeSession(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-convo-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

test('slash commands stored as command markup render as user input', async () => {
  const file = writeSession([
    {
      type: 'user',
      timestamp: '2026-07-08T08:45:46.176Z',
      message: {
        content: '<command-message>checkpoint</command-message>\n<command-name>/checkpoint</command-name>',
      },
    },
    {
      type: 'user',
      isMeta: true,
      timestamp: '2026-07-08T08:45:46.177Z',
      message: { content: 'internal command instructions should not render' },
    },
  ]);

  const convo = await extractConversation(file);
  assert.deepStrictEqual(
    convo.messages.map((m) => ({ role: m.role, text: m.text })),
    [{ role: 'user', text: '/checkpoint' }]
  );
});

test('image content blocks render an attachment marker before the text', async () => {
  const file = writeSession([
    {
      type: 'user',
      timestamp: '2026-07-08T08:00:00.000Z',
      message: {
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'def' } },
          { type: 'text', text: 'Please inspect this screenshot.' },
        ],
      },
    },
  ]);

  const convo = await extractConversation(file);
  assert.strictEqual(convo.messages[0].text, 'Please inspect this screenshot.');
  assert.deepStrictEqual(convo.messages[0].attachments, [
    { id: 'att-1', kind: 'image', mediaType: 'image/png' },
    { id: 'att-2', kind: 'image', mediaType: 'image/jpeg' },
  ]);
  assert.strictEqual(convo.attachmentsById['att-1'].data, 'abc');
  assert.strictEqual(convo.attachmentsById['att-2'].data, 'def');
});

test('assistant messages carry the model that produced them', async () => {
  const file = writeSession([
    { type: 'user', timestamp: '2026-07-15T10:00:00.000Z', message: { content: 'hi' } },
    {
      type: 'assistant',
      timestamp: '2026-07-15T10:00:01.000Z',
      message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hello' }] },
    },
  ]);
  const convo = await extractConversation(file);
  assert.strictEqual(convo.messages[0].model, undefined);
  assert.strictEqual(convo.messages[1].model, 'claude-sonnet-5');
});

test('computeModelRuns collapses contiguous same-model turns, spans interleaved messages, skips synthetic', () => {
  const messages = [
    { role: 'user', ts: 't0' },
    { role: 'assistant', ts: 't1', model: 'claude-haiku-4-5-20251001' },
    { role: 'assistant', ts: 't2', model: 'claude-haiku-4-5-20251001' },
    { role: 'user', ts: 't3' },
    { role: 'assistant', ts: 't4', model: 'claude-fable-5' },
    { role: 'assistant', ts: 't5', model: '<synthetic>' },
    { role: 'assistant', ts: 't6', model: 'claude-fable-5' },
    { role: 'user', ts: 't7' },
  ];
  const runs = computeModelRuns(messages);
  assert.strictEqual(runs.length, 2);
  assert.deepStrictEqual(
    runs.map((r) => ({ model: r.model, turns: r.turns, startIndex: r.startIndex, endIndex: r.endIndex })),
    [
      { model: 'claude-haiku-4-5-20251001', turns: 2, startIndex: 0, endIndex: 3 },
      { model: 'claude-fable-5', turns: 2, startIndex: 4, endIndex: 7 },
    ]
  );
  assert.strictEqual(runs[0].tsStart, 't1');
  assert.strictEqual(runs[0].tsEnd, 't2');
  assert.strictEqual(runs[1].tsEnd, 't6'); // synthetic turn (t5) doesn't extend tsEnd

  assert.deepStrictEqual(computeModelRuns([{ role: 'user', ts: 't0' }]), []);
});
