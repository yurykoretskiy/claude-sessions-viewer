// The core promise of this extension: it NEVER writes inside ~/.claude.
// This test patches every mutating fs API, runs the real indexing and
// conversation-extraction pipeline against a fixture ~/.claude, and fails
// if any mutating call ever targets it. CI runs this on every push.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 1. Fixture HOME with a fake ~/.claude/projects BEFORE any module loads,
//    so the indexer resolves PROJECTS_DIR inside the fixture.
// ---------------------------------------------------------------------------
const FIXTURE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-safety-'));
process.env.HOME = FIXTURE_HOME;
process.env.USERPROFILE = FIXTURE_HOME; // windows CI

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const projDir = path.join(FIXTURE_HOME, '.claude', 'projects', '-tmp-demo');
fs.mkdirSync(projDir, { recursive: true });
const sessionFile = path.join(projDir, `${SESSION_ID}.jsonl`);
fs.writeFileSync(
  sessionFile,
  [
    JSON.stringify({ type: 'user', cwd: '/tmp/demo', timestamp: '2026-01-01T10:00:00Z', message: { content: 'hello world' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T10:00:05Z', message: { content: [{ type: 'text', text: 'hi!' }] } }),
    JSON.stringify({ aiTitle: 'Demo session', 'ai-title': true }),
  ].join('\n') + '\n'
);
const bytesBefore = crypto.createHash('sha256').update(fs.readFileSync(sessionFile)).digest('hex');

// ---------------------------------------------------------------------------
// 2. Patch every mutating fs API (sync, callback, promises, streams) to
//    record the target path. Reads stay untouched.
// ---------------------------------------------------------------------------
const MUTATORS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'rename', 'renameSync', 'mkdir', 'mkdirSync',
  'copyFile', 'copyFileSync', 'truncate', 'truncateSync',
  'chmod', 'chmodSync', 'chown', 'chownSync',
  'symlink', 'symlinkSync', 'link', 'linkSync',
  'utimes', 'utimesSync', 'createWriteStream',
];
const recorded = [];
for (const name of MUTATORS) {
  const orig = fs[name];
  if (typeof orig !== 'function') continue;
  fs[name] = function (target, ...rest) {
    recorded.push({ api: name, target: String(target) });
    return orig.call(this, target, ...rest);
  };
}
for (const name of MUTATORS) {
  const orig = fs.promises[name];
  if (typeof orig !== 'function') continue;
  fs.promises[name] = function (target, ...rest) {
    recorded.push({ api: `promises.${name}`, target: String(target) });
    return orig.call(this, target, ...rest);
  };
}

// ---------------------------------------------------------------------------
// 3. Load the real modules AFTER env + patches are in place.
// ---------------------------------------------------------------------------
const { indexAll, PROJECTS_DIR } = require('../indexer');
const { extractConversation } = require('../conversation');

const CLAUDE_DIR = path.join(FIXTURE_HOME, '.claude');
const inClaude = (p) => path.resolve(p).startsWith(CLAUDE_DIR + path.sep) || path.resolve(p) === CLAUDE_DIR;

test('indexer resolves inside the fixture HOME (test is actually exercising the guard)', () => {
  assert.ok(PROJECTS_DIR.startsWith(FIXTURE_HOME), `PROJECTS_DIR=${PROJECTS_DIR}`);
});

test('full pipeline never writes inside ~/.claude', async () => {
  const cacheFile = path.join(FIXTURE_HOME, 'extension-storage', 'session-index.json');

  const sessions = await indexAll(cacheFile, undefined, { includePrompts: true });
  assert.strictEqual(sessions.length, 1, 'fixture session indexed');
  assert.strictEqual(sessions[0].cwd, '/tmp/demo');
  assert.strictEqual(sessions[0].firstMessage, 'hello world');
  assert.strictEqual(sessions[0].firstMessageRole, 'user');
  assert.strictEqual(sessions[0].lastMessage, 'hi!');
  assert.strictEqual(sessions[0].lastMessageRole, 'assistant');
  assert.strictEqual(sessions[0].messageCount, 2);
  assert.strictEqual(sessions[0].firstMessageTs, '2026-01-01T10:00:00Z');
  assert.strictEqual(sessions[0].lastMessageTs, '2026-01-01T10:00:05Z');

  const convo = await extractConversation(sessionFile);
  assert.ok(convo.messages.length >= 1, 'conversation extracted');

  // Positive control: interception works — the cache write MUST be recorded.
  const cacheWrites = recorded.filter((r) => r.target.includes('extension-storage'));
  assert.ok(cacheWrites.length >= 1, 'fs interception is live (cache write observed)');

  // The guarantee: zero mutating calls under ~/.claude.
  const violations = recorded.filter((r) => inClaude(r.target));
  assert.deepStrictEqual(violations, [], `mutating fs calls under ~/.claude: ${JSON.stringify(violations)}`);

  // Belt and braces: the transcript bytes are untouched.
  const bytesAfter = crypto.createHash('sha256').update(fs.readFileSync(sessionFile)).digest('hex');
  assert.strictEqual(bytesAfter, bytesBefore, 'session transcript bytes unchanged');
});

test('re-index from warm cache also never writes inside ~/.claude', async () => {
  const cacheFile = path.join(FIXTURE_HOME, 'extension-storage', 'session-index.json');
  recorded.length = 0;
  await indexAll(cacheFile, undefined, { includePrompts: true });
  const violations = recorded.filter((r) => inClaude(r.target));
  assert.deepStrictEqual(violations, []);
});
