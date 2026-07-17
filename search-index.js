// Global precise-search index: the chat text (user + assistant only — exactly
// what the conversation viewer renders) of every session under
// ~/.claude/projects, cached per file like indexer.js so only changed
// transcripts are re-read. Tool traffic (Write/Edit bodies, tool results) is
// deliberately NOT indexed — see BACKLOG.md; revisit only if real use shows
// chat-only search misses copy-paste sources.

const fs = require('fs');
const readline = require('readline');
const { listSessionFiles, loadCache, saveCache } = require('./indexer');
const { textFromContent, MSG_CHAR_CAP } = require('./conversation');

// Bump when the extracted shape changes so stale cache entries re-index.
const SEARCH_INDEX_VERSION = 1;

const MIN_QUERY_LEN = 2;
const SNIPPET_RADIUS = 100; // chars of context on each side of a hit
const MAX_SNIPPETS_PER_SESSION = 20;

// One transcript -> [{r:'u'|'a', ts, x}] using the same skip rules as the
// viewer (sidechains, meta records, command markup, '<'-prefixed harness
// text) and the same per-message cap, so a hit found here is always present
// verbatim in the opened conversation.
async function extractSearchEntries(filePath) {
  const entries = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if ((obj.type !== 'user' && obj.type !== 'assistant') || !obj.message) continue;
    if (obj.isSidechain || obj.isMeta) continue;
    const { text } = textFromContent(obj.message.content);
    if (!text) continue;
    entries.push({
      r: obj.type === 'user' ? 'u' : 'a',
      ts: obj.timestamp || null,
      x: text.length > MSG_CHAR_CAP ? text.slice(0, MSG_CHAR_CAP) : text,
    });
  }
  return entries;
}

// Loads/refreshes the search index. Returns [{file, id, entries}], reading
// only files whose (mtime,size) changed since the cached extraction.
async function buildSearchIndex(cacheFile, onProgress) {
  const cache = loadCache(cacheFile);
  const files = listSessionFiles();
  const result = [];
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
    if (cached && cached.v === SEARCH_INDEX_VERSION && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      result.push({ file, id: idFromFile(file), entries: cached.entries });
    } else {
      try {
        const entries = await extractSearchEntries(file);
        cache[file] = { v: SEARCH_INDEX_VERSION, mtimeMs: stat.mtimeMs, size: stat.size, entries };
        result.push({ file, id: idFromFile(file), entries });
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
  return result;
}

function idFromFile(file) {
  const base = file.slice(file.lastIndexOf('/') + 1);
  return base.endsWith('.jsonl') ? base.slice(0, -6) : base;
}

// ~SNIPPET_RADIUS chars either side of the hit, trimmed to word boundaries.
// Returns raw text pieces; the webview escapes and wraps the hit in <mark>.
function snippetAt(text, at, len) {
  let start = Math.max(0, at - SNIPPET_RADIUS);
  let end = Math.min(text.length, at + len + SNIPPET_RADIUS);
  if (start > 0) {
    const sp = text.indexOf(' ', start);
    if (sp !== -1 && sp < at) start = sp + 1;
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > at + len) end = sp;
  }
  const clean = (s) => s.replace(/\s+/g, ' ');
  return {
    before: (start > 0 ? '…' : '') + clean(text.slice(start, at)),
    hit: clean(text.slice(at, at + len)),
    after: clean(text.slice(at + len, end)) + (end < text.length ? '…' : ''),
  };
}

// Exact-phrase search over the built index, always case-insensitive. Returns
// [{file, id, total, snippets: [{r, ts, before, hit, after}]}] — snippets
// capped per session, total is the uncapped match count.
function searchIndex(indexed, phrase) {
  const query = String(phrase || '');
  if (query.length < MIN_QUERY_LEN) return [];
  const needle = query.toLowerCase();
  const out = [];
  for (const session of indexed) {
    let total = 0;
    const snippets = [];
    for (const e of session.entries) {
      const hay = e.x.toLowerCase();
      let at = hay.indexOf(needle);
      let firstInEntry = true;
      while (at !== -1) {
        total++;
        if (snippets.length < MAX_SNIPPETS_PER_SESSION && firstInEntry) {
          snippets.push({ r: e.r, ts: e.ts, ...snippetAt(e.x, at, needle.length) });
        }
        firstInEntry = false;
        at = hay.indexOf(needle, at + needle.length);
      }
    }
    if (total) out.push({ file: session.file, id: session.id, total, snippets });
  }
  return out;
}

module.exports = { buildSearchIndex, searchIndex, extractSearchEntries, snippetAt, MIN_QUERY_LEN };
