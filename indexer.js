// Streams Claude Code session .jsonl files under ~/.claude/projects and
// extracts per-session metadata: title, cwd, last activity, and which
// workspace subfolders the session actually touched (path mentions).
// Results are cached per (mtime, size) so only changed files are re-read.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Bump when the extracted shape changes so stale cache entries re-index.
const INDEX_VERSION = 3;

const RE_TIMESTAMP = /"timestamp":"([^"]+)"/;
const RE_CWD = /"cwd":"([^"]+)"/;
const MAX_PROMPTS = 300;
const PROMPT_CHARS = 200;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    lastTs: null,
    folderMentions: {},
    prompts: [],
  };
  let mentionRe = null;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const tsMatch = RE_TIMESTAMP.exec(line);
    if (tsMatch) result.lastTs = tsMatch[1];

    if (!result.cwd) {
      const cwdMatch = RE_CWD.exec(line);
      if (cwdMatch) {
        result.cwd = cwdMatch[1];
        mentionRe = new RegExp(
          escapeRegExp(result.cwd) + '/([A-Za-z0-9._][A-Za-z0-9._-]*)',
          'g'
        );
      }
    }

    if (mentionRe && line.length < 2_000_000) {
      mentionRe.lastIndex = 0;
      let m;
      while ((m = mentionRe.exec(line)) !== null) {
        const seg = m[1];
        result.folderMentions[seg] = (result.folderMentions[seg] || 0) + 1;
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
    } else if (line.includes('"type":"user"') && line.length < 64 * 1024) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' && obj.message && !obj.isSidechain && !obj.isMeta) {
          const c = obj.message.content;
          let text = null;
          if (typeof c === 'string') text = c;
          else if (Array.isArray(c)) {
            const t = c.find((p) => p.type === 'text' && p.text);
            if (t) text = t.text;
          }
          if (text && !text.startsWith('<')) {
            const clean = text.replace(/\s+/g, ' ').trim().slice(0, PROMPT_CHARS);
            if (includePrompts && clean && result.prompts.length < MAX_PROMPTS) result.prompts.push(clean);
            if (!result.firstPrompt) result.firstPrompt = clean.slice(0, 120);
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

function listSessionFiles() {
  const files = [];
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
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

// Returns array of session metadata objects; onProgress(done, total) optional.
async function indexAll(cacheFile, onProgress, options = {}) {
  const includePrompts = options.includePrompts !== false;
  const cacheVersion = `${INDEX_VERSION}:${includePrompts ? 'prompts' : 'session'}`;
  const cache = loadCache(cacheFile);
  const files = listSessionFiles();
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
      sessions.push(cached.data);
    } else {
      try {
        const data = await indexSessionFile(file, { includePrompts });
        data.mtimeMs = stat.mtimeMs;
        data.size = stat.size;
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

module.exports = { indexAll, PROJECTS_DIR };
