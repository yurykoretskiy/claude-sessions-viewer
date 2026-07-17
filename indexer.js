// Streams Claude Code session .jsonl files under ~/.claude/projects and
// extracts compact per-session metadata: title, cwd, activity, and message
// previews. Full conversations are parsed only when the viewer opens them.
// Results are cached per (mtime, size) so only changed files are re-read.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Bump when the extracted shape changes so stale cache entries re-index.
const INDEX_VERSION = 9;

const RE_TIMESTAMP = /"timestamp":"([^"]+)"/;
const RE_CWD = /"cwd":"([^"]+)"/;
const RE_ENTRYPOINT = /"entrypoint":"([^"]+)"/;
const MAX_PROMPTS = 300;
const PROMPT_CHARS = 200;
const MESSAGE_HEAD_CHARS = 180;
const MESSAGE_TAIL_CHARS = 120;
// Claude can put an image and its text in one large JSONL record. Keep the
// parser bounded per line, but do not silently drop ordinary readable turns.
const MAX_MESSAGE_LINE = 4 * 1024 * 1024;

function messageText(content) {
  if (typeof content === 'string') {
    const source = content;
    const named = source.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
    if (named && named[1].trim()) return named[1].trim();
    const message = source.match(/<command-message>\s*([^<]+?)\s*<\/command-message>/);
    if (message && message[1].trim()) {
      const value = message[1].trim();
      return value.startsWith('/') ? value : `/${value}`;
    }
    return content.startsWith('<') ? '' : content;
  }
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('\n');
}

async function indexSessionFile(filePath, options = {}) {
  const includePrompts = options.includePrompts !== false;
  const id = path.basename(filePath, '.jsonl');
  const result = {
    id,
    file: filePath,
    title: null,
    firstPrompt: null,
    lastPrompt: null,
    cwd: null,
    entrypoint: null,
    firstMessage: null,
    firstMessageRole: null,
    firstMessageTs: null,
    lastMessage: null,
    lastMessageTail: null,
    lastMessageLength: 0,
    lastMessageRole: null,
    lastMessageTs: null,
    messageCount: 0,
    lastTs: null,
    prompts: [],
  };
  let previousMessageRole = null;
  let previousMessageTs = null;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const tsMatch = RE_TIMESTAMP.exec(line);
    if (tsMatch) result.lastTs = tsMatch[1];

    if (!result.entrypoint) {
      const epMatch = RE_ENTRYPOINT.exec(line);
      if (epMatch) result.entrypoint = epMatch[1];
    }

    if (!result.cwd) {
      const cwdMatch = RE_CWD.exec(line);
      if (cwdMatch) {
        result.cwd = cwdMatch[1];
      }
    }

    // Short metadata lines: parse only when the cheap substring check hits.
    if (line.includes('"ai-title"') && line.length < 4096) {
      try {
        const obj = JSON.parse(line);
        if (obj.aiTitle) result.title = obj.aiTitle;
      } catch {}
    } else if (line.includes('"last-prompt"') && line.length < 16384) {
      try {
        const obj = JSON.parse(line);
        if (obj.lastPrompt) result.lastPrompt = obj.lastPrompt;
      } catch {}
    } else if ((line.includes('"type":"user"') || line.includes('"type":"assistant"')) && line.length < MAX_MESSAGE_LINE) {
      try {
        const obj = JSON.parse(line);
        if ((obj.type === 'user' || obj.type === 'assistant') && obj.message && !obj.isSidechain && !obj.isMeta) {
          const text = messageText(obj.message.content);
          if (text) {
            const normalized = text.replace(/\s+/g, ' ').trim();
            const clean = normalized.slice(0, PROMPT_CHARS);
            const ts = tsMatch ? tsMatch[1] : null;
            const sameAssistantTurn =
              obj.type === 'assistant' && previousMessageRole === 'assistant' && previousMessageTs === ts;
            if (!sameAssistantTurn) result.messageCount++;
            if (!result.firstMessage) {
              result.firstMessage = clean;
              result.firstMessageRole = obj.type;
              result.firstMessageTs = ts;
            }
            result.lastMessage = normalized.slice(0, MESSAGE_HEAD_CHARS);
            result.lastMessageTail = normalized.length > MESSAGE_HEAD_CHARS
              ? normalized.slice(-MESSAGE_TAIL_CHARS)
              : null;
            result.lastMessageLength = normalized.length;
            result.lastMessageRole = obj.type;
            result.lastMessageTs = ts;
            previousMessageRole = obj.type;
            previousMessageTs = ts;
            if (obj.type === 'user') {
              if (includePrompts && clean && result.prompts.length < MAX_PROMPTS) result.prompts.push(clean);
              if (!result.firstPrompt) result.firstPrompt = clean.slice(0, 120);
            }
          }
        }
      } catch {}
    }
  }

  return result;
}

function loadCache(cacheFile) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cacheFile, cache) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  } catch {}
}

function listSessionFiles(projectsDir = PROJECTS_DIR) {
  const files = [];
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir, d.name);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        files.push(path.join(dir, e.name));
      }
    }
  }
  return files;
}

// A session has two clocks: the last content timestamp inside the transcript
// (lastTs) and the file's mtime. Claude Code appends metadata records without
// timestamps (ai-title, last-prompt, mode) after the conversation, so lastTs
// can go stale while the file is still being written. "Last activity" for
// sorting/age is the NEWER of the two — the same signal the live ● marker
// uses, so age, order, and liveness can never contradict each other.
function effectiveTs(lastTs, mtimeMs) {
  const content = lastTs ? Date.parse(lastTs) || 0 : 0;
  const eff = Math.max(content, mtimeMs || 0);
  return eff ? new Date(eff).toISOString() : '';
}

// Returns array of session metadata objects; onProgress(done, total) optional.
async function indexAll(cacheFile, onProgress, options = {}) {
  const includePrompts = options.includePrompts !== false;
  const cacheVersion = `${INDEX_VERSION}:${includePrompts ? 'prompts' : 'session'}`;
  const cache = loadCache(cacheFile);
  const files = listSessionFiles(options.projectsDir || PROJECTS_DIR);
  const sessions = [];
  const seen = new Set();
  let dirty = false;
  let done = 0;

  for (const file of files) {
    seen.add(file);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const cached = cache[file];
    if (cached && cached.v === cacheVersion && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      cached.data.size = cached.size;
      cached.data.effTs = effectiveTs(cached.data.lastTs, cached.mtimeMs);
      sessions.push(cached.data);
    } else {
      try {
        const data = await indexSessionFile(file, { includePrompts });
        data.mtimeMs = stat.mtimeMs;
        data.size = stat.size;
        data.effTs = effectiveTs(data.lastTs, stat.mtimeMs);
        cache[file] = { v: cacheVersion, mtimeMs: stat.mtimeMs, size: stat.size, data };
        sessions.push(data);
        dirty = true;
      } catch {}
    }
    done++;
    if (onProgress) onProgress(done, files.length);
  }

  for (const key of Object.keys(cache)) {
    if (!seen.has(key)) {
      delete cache[key];
      dirty = true;
    }
  }
  if (dirty) saveCache(cacheFile, cache);
  return sessions;
}

// Automation shells (/security-review runs, SDK agents) are real transcript
// files but not conversations the user had: their entrypoint is sdk-py /
// sdk-cli, while interactive sessions are claude-vscode / cli. Old
// transcripts without the field count as interactive (never hide by guess).
function isAutomationSession(s) {
  return typeof s.entrypoint === 'string' && s.entrypoint.startsWith('sdk');
}

module.exports = { indexAll, PROJECTS_DIR, effectiveTs, isAutomationSession, listSessionFiles, loadCache, saveCache };
