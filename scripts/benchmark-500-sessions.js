const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { indexAll } = require('../indexer');

const SESSION_COUNT = Number(process.env.BENCH_SESSIONS || 500);
const SESSION_BYTES = Number(process.env.BENCH_SESSION_BYTES || 256 * 1024);
const PROJECT_COUNT = Math.min(50, SESSION_COUNT);

function uuid(index) {
  const suffix = index.toString(16).padStart(12, '0');
  return `10000000-0000-4000-8000-${suffix}`;
}

function writeFixture(file, cwd, index) {
  const payload = `Session ${index} performance payload `.repeat(70);
  const lines = [];
  let turn = 0;
  let size = 0;
  while (size < SESSION_BYTES) {
    const role = turn % 2 === 0 ? 'user' : 'assistant';
    const record = JSON.stringify({
      type: role,
      cwd,
      timestamp: new Date(Date.UTC(2026, 6, 1, 0, 0, turn)).toISOString(),
      message: { content: role === 'user' ? payload : [{ type: 'text', text: payload }] },
    });
    lines.push(record);
    size += Buffer.byteLength(record) + 1;
    turn++;
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function memoryMb() {
  if (global.gc) global.gc();
  const usage = process.memoryUsage();
  return { heap: usage.heapUsed / 1024 / 1024, rss: usage.rss / 1024 / 1024 };
}

async function measure(label, cacheFile, projectsDir) {
  const before = memoryMb();
  const started = performance.now();
  const sessions = await indexAll(cacheFile, undefined, { includePrompts: false, projectsDir });
  const elapsed = performance.now() - started;
  const after = memoryMb();
  return {
    label,
    sessions: sessions.length,
    ms: Math.round(elapsed),
    heapDeltaMb: +(after.heap - before.heap).toFixed(1),
    rssDeltaMb: +(after.rss - before.rss).toFixed(1),
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-benchmark-'));
  const projectsDir = path.join(root, 'projects');
  const cacheFile = path.join(root, 'cache', 'session-index.json');
  fs.mkdirSync(projectsDir, { recursive: true });

  try {
    for (let i = 0; i < SESSION_COUNT; i++) {
      const project = path.join(projectsDir, `project-${i % PROJECT_COUNT}`);
      fs.mkdirSync(project, { recursive: true });
      writeFixture(path.join(project, `${uuid(i)}.jsonl`), `/tmp/project-${i % PROJECT_COUNT}`, i);
    }

    const cold = await measure('cold rebuild', cacheFile, projectsDir);
    const warm = await measure('warm cache', cacheFile, projectsDir);
    const changed = path.join(projectsDir, 'project-0', `${uuid(0)}.jsonl`);
    fs.appendFileSync(changed, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: 'changed' } }) + '\n');
    const incremental = await measure('one changed session', cacheFile, projectsDir);

    console.log(`Dataset: ${SESSION_COUNT} sessions, about ${Math.round(SESSION_BYTES / 1024)} KiB each`);
    console.table([cold, warm, incremental]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
