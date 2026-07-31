// #codex
// Lightweight indexer and conversation reader for local Codex sessions.
// The sidebar indexes only top-level threads from ~/.codex/sessions. Subagent
// sidechains are intentionally excluded, matching the Claude indexer's rule.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const CODEX_INDEX_VERSION = 3;
const TITLE_CHARS = 180;
const MESSAGE_CHARS = 8000;

function listCodexSessionFiles(root = CODEX_SESSIONS_DIR) {
  const files = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) files.push(full);
    }
  };
  visit(root);
  return files;
}

function stripAmbientBlocks(value) {
  return String(value || '')
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi, '')
    .replace(/<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<recommended_plugins\b[^>]*>[\s\S]*?<\/recommended_plugins>/gi, '')
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/gi, '')
    .trim();
}

function visibleMessageText(value) {
  const text = stripAmbientBlocks(value).replace(/\s+/g, ' ').trim();
  return text.slice(0, MESSAGE_CHARS);
}

function titleFromMessage(value) {
  let raw = stripAmbientBlocks(value);
  const explicitRequest = raw.match(/## My request for Codex:\s*([\s\S]*)/i);
  if (explicitRequest && explicitRequest[1].trim()) raw = explicitRequest[1];
  let text = raw.replace(/\s+/g, ' ').trim();
  text = text
    .replace(/^# Files mentioned by the user:\s*/i, '')
    .replace(/^#+\s*/, '')
    .replace(/^[-*]\s+/, '')
    .trim();
  const line = text.split(/\n|(?<=[.!?])\s+/)[0] || text;
  return line.slice(0, TITLE_CHARS).trim();
}

function loadCache(cacheFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return parsed.version === CODEX_INDEX_VERSION && parsed.files ? parsed.files : {};
  } catch {
    return {};
  }
}

function saveCache(cacheFile, files) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: CODEX_INDEX_VERSION, files }));
    fs.renameSync(tmp, cacheFile);
  } catch {
    // The viewer still works without a cache; the next refresh will rescan.
  }
}

async function indexCodexSessionFile(filePath, stat = fs.statSync(filePath)) {
  let meta = null;
  let firstUser = '';
  let currentCwd = null;
  const activityByDayAndFolder = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"event_msg"')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'session_meta') {
      meta = event.payload || {};
      if (meta.source && meta.source.subagent) break;
      if (typeof meta.cwd === 'string') currentCwd = meta.cwd;
    } else if (event.type === 'turn_context') {
      if (event.payload && typeof event.payload.cwd === 'string') currentCwd = event.payload.cwd;
    } else if (event.type === 'event_msg' && event.payload) {
      const kind = event.payload.type;
      if (kind !== 'user_message' && kind !== 'agent_message') continue;
      const candidate = visibleMessageText(event.payload.message);
      if (!candidate) continue;
      if (kind === 'user_message' && !firstUser) firstUser = candidate;
      const ts = typeof event.timestamp === 'string' ? event.timestamp : null;
      const cwd = currentCwd || (meta && typeof meta.cwd === 'string' ? meta.cwd : null);
      const date = ts ? new Date(ts) : null;
      if (ts && cwd && date && !Number.isNaN(date.getTime())) {
        const day = [
          date.getFullYear(),
          String(date.getMonth() + 1).padStart(2, '0'),
          String(date.getDate()).padStart(2, '0'),
        ].join('-');
        const key = `${day}\u0000${cwd}`;
        const previous = activityByDayAndFolder.get(key);
        if (!previous || Date.parse(ts) > Date.parse(previous.ts)) {
          activityByDayAndFolder.set(key, { ts, cwd });
        }
      }
    }
  }

  if (!meta || (meta.source && meta.source.subagent)) return null;
  const id = String(meta.id || path.basename(filePath, '.jsonl').match(/([0-9a-f-]{36})$/i)?.[1] || '');
  if (!id) return null;
  const started = meta.timestamp || new Date(stat.birthtimeMs || stat.mtimeMs).toISOString();
  const activities = [...activityByDayAndFolder.values()]
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const activityTs = activities.length ? activities[activities.length - 1].ts : null;
  return {
    id,
    file: filePath,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
    title: titleFromMessage(firstUser) || `Codex session ${id.slice(0, 8)}`,
    firstPrompt: firstUser.slice(0, TITLE_CHARS) || null,
    firstTs: started,
    lastTs: activityTs,
    activityTs,
    activities,
    effTs: new Date(stat.mtimeMs).toISOString(),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    source: 'codex',
  };
}

async function indexAllCodex(cacheFile, root = CODEX_SESSIONS_DIR) {
  const cached = loadCache(cacheFile);
  const next = {};
  const sessions = [];
  for (const file of listCodexSessionFiles(root)) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const old = cached[file];
    let data = old && old.mtimeMs === stat.mtimeMs && old.size === stat.size ? old.data : null;
    if (!data) data = await indexCodexSessionFile(file, stat);
    next[file] = { mtimeMs: stat.mtimeMs, size: stat.size, data };
    if (data) sessions.push(data);
  }
  saveCache(cacheFile, next);
  const byId = new Map();
  for (const session of sessions) {
    const previous = byId.get(session.id);
    const activity = Date.parse(session.activityTs || '') || 0;
    const previousActivity = previous ? Date.parse(previous.activityTs || '') || 0 : -1;
    if (!previous || activity > previousActivity || (activity === previousActivity && session.mtimeMs > previous.mtimeMs)) {
      byId.set(session.id, session);
    }
  }
  return [...byId.values()].sort((a, b) =>
    (Date.parse(b.activityTs || '') || 0) - (Date.parse(a.activityTs || '') || 0) ||
    (b.mtimeMs || 0) - (a.mtimeMs || 0)
  );
}

function contentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && ['input_text', 'output_text', 'text'].includes(part.type) && part.text)
    .map((part) => part.text)
    .join('\n')
    .trim();
}

async function extractCodexConversation(filePath) {
  const messages = [];
  let firstTs = null;
  let lastTs = null;
  let sawVisibleEvents = false;
  const fallback = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.includes('"event_msg"') && !line.includes('"response_item"')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const ts = event.timestamp || null;
    if (event.type === 'event_msg' && event.payload) {
      const kind = event.payload.type;
      if (kind !== 'user_message' && kind !== 'agent_message') continue;
      const text = visibleMessageText(event.payload.message);
      if (!text) continue;
      sawVisibleEvents = true;
      messages.push({ role: kind === 'user_message' ? 'user' : 'assistant', text, ts });
      if (ts && !firstTs) firstTs = ts;
      if (ts) lastTs = ts;
    } else if (event.type === 'response_item' && event.payload && event.payload.type === 'message') {
      const role = event.payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = visibleMessageText(contentText(event.payload.content));
      if (!text || /^# AGENTS\.md instructions for\b/i.test(text)) continue;
      fallback.push({ role, text, ts });
    }
  }

  const chosen = sawVisibleEvents ? messages : fallback;
  if (!firstTs && chosen.length) firstTs = chosen.find((message) => message.ts)?.ts || null;
  if (!lastTs && chosen.length) lastTs = [...chosen].reverse().find((message) => message.ts)?.ts || firstTs;
  return { messages: chosen, attachmentsById: {}, firstTs, lastTs };
}

module.exports = {
  CODEX_SESSIONS_DIR,
  CODEX_INDEX_VERSION,
  listCodexSessionFiles,
  indexCodexSessionFile,
  indexAllCodex,
  extractCodexConversation,
  stripAmbientBlocks,
  titleFromMessage,
};
