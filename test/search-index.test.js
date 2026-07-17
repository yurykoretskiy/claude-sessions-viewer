const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractSearchEntries, searchIndex, snippetAt } = require('../search-index');

function writeSession(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-search-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

test('extracts user and assistant chat text only, viewer skip rules applied', async () => {
  const file = writeSession([
    { type: 'user', timestamp: '2026-07-14T10:00:00.000Z', message: { content: 'feed the hermes board with tools' } },
    { type: 'user', isMeta: true, message: { content: 'meta record must not be searchable' } },
    { type: 'user', isSidechain: true, message: { content: 'sidechain must not be searchable' } },
    { type: 'user', message: { content: '<system-reminder>harness text must not be searchable</system-reminder>' } },
    {
      type: 'assistant',
      timestamp: '2026-07-14T10:01:00.000Z',
      message: {
        content: [
          { type: 'text', text: 'the board routes messages to the agent' },
          { type: 'tool_use', name: 'Bash', input: { command: 'echo tool input must not be searchable' } },
        ],
      },
    },
  ]);

  const entries = await extractSearchEntries(file);
  assert.deepStrictEqual(
    entries.map((e) => ({ r: e.r, x: e.x })),
    [
      { r: 'u', x: 'feed the hermes board with tools' },
      { r: 'a', x: 'the board routes messages to the agent' },
    ]
  );
});

test('slash command markup is searchable as the command name', async () => {
  const file = writeSession([
    {
      type: 'user',
      timestamp: '2026-07-14T10:00:00.000Z',
      message: { content: '<command-message>checkpoint</command-message>\n<command-name>/checkpoint</command-name>' },
    },
  ]);
  const entries = await extractSearchEntries(file);
  assert.deepStrictEqual(entries.map((e) => e.x), ['/checkpoint']);
});

test('long messages are capped like the viewer so hits stay verbatim-findable', async () => {
  const file = writeSession([
    { type: 'user', timestamp: '2026-07-14T10:00:00.000Z', message: { content: 'x'.repeat(9000) } },
  ]);
  const entries = await extractSearchEntries(file);
  assert.strictEqual(entries[0].x.length, 8000);
});

test('exact-phrase search: counts all matches, one snippet per message, always case-insensitive', () => {
  const indexed = [
    {
      file: '/tmp/a.jsonl',
      id: 'a',
      entries: [
        { r: 'u', ts: '2026-07-14T10:00:00.000Z', x: 'Hermes board here, hermes board there' },
        { r: 'a', ts: '2026-07-14T10:01:00.000Z', x: 'no mention at all' },
        { r: 'a', ts: '2026-07-14T10:02:00.000Z', x: 'the hermes board again' },
      ],
    },
    { file: '/tmp/b.jsonl', id: 'b', entries: [{ r: 'u', ts: null, x: 'unrelated' }] },
  ];

  const results = searchIndex(indexed, 'hermes board');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].total, 3);
  assert.strictEqual(results[0].snippets.length, 2); // one per matching message
  assert.strictEqual(results[0].snippets[0].hit, 'Hermes board');

  assert.deepStrictEqual(searchIndex(indexed, 'h'), []); // below min length
});

test('snippets trim to word boundaries with ellipses and squashed whitespace', () => {
  const pad = 'word '.repeat(60); // 300 chars either side
  const text = pad + 'NEEDLE\nnext line' + pad;
  const at = text.indexOf('NEEDLE');
  const s = snippetAt(text, at, 'NEEDLE'.length);
  assert.ok(s.before.startsWith('…'));
  assert.ok(s.after.endsWith('…'));
  assert.strictEqual(s.hit, 'NEEDLE');
  assert.ok(!s.after.includes('\n'));
  assert.ok(s.before.length <= 110 && s.after.length <= 110);
});
