const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractConversation } = require('../conversation');

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
