#!/usr/bin/env node
// Standalone morning viewer — no VS Code required. Read-only observer: the
// recent sessions across ALL folders, grouped for the morning re-entry flow.
// No rename, no resume-in-terminal, no state changes — just look, open a
// conversation, or launch VS Code at the session's folder. Reuses the
// extension's own VS-Code-free engine
// (indexer.js, conversation.js, viewer.js) — this file only adds the HTTP
// front end.
//
// Run: node standalone.js   (or: npm run standalone)
// Then open the printed http://127.0.0.1:<port> URL in a browser.

const http = require('http');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const Module = require('module');

// viewer.js does `require('vscode')` at module load time. Stub just enough
// of the API for ConversationViewer.html() to render: a fixed 'dark' theme
// (not 'system' — there's no VS Code webview host here to supply the
// --vscode-* CSS variables the 'system' theme reads), sensible label
// defaults, and no-op everywhere else.
const fakeVscode = {
  workspace: { getConfiguration: () => ({ get: (k, d) => (k === 'theme' ? 'dark' : d) }) },
  window: {},
  ViewColumn: { One: 1, Beside: -2 },
  ConfigurationTarget: { Global: 1 },
  Uri: { file: (f) => ({ fsPath: f }) },
  env: {},
  commands: {},
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return fakeVscode;
  return origLoad.call(this, request, ...rest);
};

const { indexAll, isAutomationSession } = require('./indexer');
const { extractConversation } = require('./conversation');
const { ConversationViewer } = require('./viewer');

const PORT = Number(process.env.PORT) || 4179;
const HOST = '127.0.0.1'; // loopback only — this server executes `code <folder>` on request
const CACHE_FILE = path.join(os.tmpdir(), 'claude-sessions-viewer-standalone-index.json');
const LAST_N = Number(process.env.LAST_N) || 30;

const viewer = new ConversationViewer({});

function folderLabel(cwd) {
  if (!cwd) return '?';
  if (cwd === os.homedir()) return '~';
  return path.basename(cwd) || cwd;
}
function displayTitle(s) {
  return s.title || s.firstPrompt || s.lastPrompt || s.id.slice(0, 8);
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtWhen(ts) {
  if (!ts) return '?';
  const d = new Date(ts);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function fmtTime(ts) {
  if (!ts) return '?';
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function dayKey(ts) {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayLabel(key) {
  if (key === 'unknown') return 'Unknown date';
  const now = new Date();
  const today = dayKey(now.toISOString());
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const yesterday = dayKey(y.toISOString());
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return new Date(key + 'T12:00:00').toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });
}
function excerpt(text, max = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
}
function hasHandoff(messages) {
  const haystack = messages
    .filter((m) => m.role !== 'tool')
    .slice(-8)
    .map((m) => m.text || '')
    .join('\n')
    .toLowerCase();
  return /\bhandoff\b|handoff\.md|continue in (another|a new|next) session|next steps|remaining work/.test(haystack);
}
function endingState(convo) {
  const visible = convo.messages.filter((m) => m.role !== 'tool');
  if (!visible.length) return { key: 'empty', label: 'Empty session' };
  if (visible.length === 1) return { key: 'minimal', label: 'Minimal session' };
  const last = convo.messages[convo.messages.length - 1];
  if (last && last.role === 'tool') return { key: 'tool', label: 'Ended after tool activity' };
  if (last && last.role === 'user') return { key: 'waiting', label: 'Waiting after user message' };
  if (hasHandoff(convo.messages)) return { key: 'handoff', label: 'Handoff mentioned' };
  return { key: 'assistant', label: 'Ended with assistant message' };
}
function durationLabel(firstTs, lastTs) {
  if (!firstTs || !lastTs) return '';
  const mins = Math.max(0, Math.round((Date.parse(lastTs) - Date.parse(firstTs)) / 60000));
  if (!Number.isFinite(mins) || mins <= 0) return '';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

async function lastSessions(limit = LAST_N) {
  const all = await indexAll(CACHE_FILE);
  return all
    .filter((s) => !isAutomationSession(s))
    .sort((a, b) => (b.effTs || b.lastTs || '').localeCompare(a.effTs || a.lastTs || ''))
    .slice(0, limit);
}

async function sessionSummaries(limit = LAST_N) {
  const sessions = await lastSessions(limit);
  const summaries = [];
  for (const session of sessions) {
    let convo = { messages: [], firstTs: null, lastTs: null };
    try {
      convo = await extractConversation(session.file);
    } catch {}
    const visible = convo.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    const firstUser = visible.find((m) => m.role === 'user');
    const lastUser = [...visible].reverse().find((m) => m.role === 'user');
    const lastAssistant = [...visible].reverse().find((m) => m.role === 'assistant');
    const models = [
      ...new Set(
        visible
          .filter((m) => m.role === 'assistant' && m.model && m.model !== '<synthetic>')
          .map((m) => m.model)
      ),
    ];
    summaries.push({
      session,
      convo,
      title: displayTitle(session),
      folder: folderLabel(session.cwd),
      firstUser: excerpt(firstUser && firstUser.text),
      lastUser: excerpt(lastUser && lastUser.text),
      lastAssistant: excerpt(lastAssistant && lastAssistant.text),
      visibleCount: visible.length,
      toolCount: convo.messages.filter((m) => m.role === 'tool').length,
      models,
      state: endingState(convo),
      duration: durationLabel(convo.firstTs, convo.lastTs),
      day: dayKey(session.effTs || session.lastTs),
    });
  }
  return summaries;
}

function groupedSummaries(summaries) {
  const days = new Map();
  for (const item of summaries) {
    if (!days.has(item.day)) days.set(item.day, new Map());
    const projects = days.get(item.day);
    const projectKey = item.session.cwd || '(unknown)';
    if (!projects.has(projectKey)) projects.set(projectKey, []);
    projects.get(projectKey).push(item);
  }
  return [...days.entries()].map(([day, projects]) => ({
    day,
    projects: [...projects.entries()].map(([cwd, items]) => ({ cwd, items })),
  }));
}

function listHtml(summaries) {
  const meaningful = summaries.filter((s) => s.state.key !== 'empty' && s.state.key !== 'minimal').length;
  const projects = new Set(summaries.map((s) => s.session.cwd || '(unknown)')).size;
  const needsAttention = summaries.filter((s) => s.state.key === 'tool' || s.state.key === 'waiting').length;
  const grouped = groupedSummaries(summaries);
  const sections = grouped
    .map(({ day, projects: projectGroups }) => {
      const projectHtml = projectGroups
        .map(({ cwd, items }) => {
          const last = items[0] && (items[0].session.effTs || items[0].session.lastTs);
          const rows = items
            .map((item) => {
              const s = item.session;
              const model = item.models.length ? item.models.join(' → ') : 'model unknown';
              const final = item.lastAssistant || item.lastUser || item.firstUser || 'No readable conversation text.';
              const started = item.firstUser || '';
              const timing = [
                fmtTime(s.effTs || s.lastTs),
                item.duration,
                `${item.visibleCount} messages`,
                item.toolCount ? `${item.toolCount} tool groups hidden` : '',
                model,
              ].filter(Boolean).join(' · ');
              return `<article class="card">
                <div class="cardTop">
                  <div class="cardTitle">${esc(item.title)}</div>
                  <span class="badge ${esc(item.state.key)}">${esc(item.state.label)}</span>
                </div>
                <div class="meta">${esc(timing)}</div>
                ${started ? `<div class="quote"><span>Started</span>${esc(started)}</div>` : ''}
                <div class="quote last"><span>Ended</span>${esc(final)}</div>
                <div class="actions">
                  <button class="a primary" data-open="${esc(s.id)}">Open conversation</button>
                  <button class="a" data-code="${esc(s.cwd || '')}">Open project</button>
                </div>
              </article>`;
            })
            .join('');
          return `<section class="project">
            <div class="projectHead">
              <div>
                <h2>${esc(folderLabel(cwd))}</h2>
                <div class="path">${esc(cwd || 'Unknown folder')}</div>
              </div>
              <div class="projectMeta">${items.length} session${items.length === 1 ? '' : 's'} · last ${esc(fmtWhen(last))}</div>
            </div>
            <div class="cards">${rows}</div>
          </section>`;
        })
        .join('');
      const count = projectGroups.reduce((n, p) => n + p.items.length, 0);
      return `<section class="day">
        <div class="dayHead"><h1>${esc(dayLabel(day))}</h1><span>${count} session${count === 1 ? '' : 's'}</span></div>
        ${projectHtml}
      </section>`;
    })
    .join('');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Start My Day — Claude Sessions</title>
<style>
  :root {
    --bg:#181818; --panel:#202020; --card:#252525; --fg:#d7d7d7; --mut:#969696; --soft:#bdbdbd;
    --line:#383838; --line2:#454545; --hover:#2c2c2c; --btn:#333; --accent:#8fd6ac; --warn:#e8c878;
    --coral:#e59a86;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font-family:-apple-system,'SF Pro Text','Segoe UI',sans-serif; font-size:13px; line-height:1.5; }
  .shell { max-width:940px; margin:0 auto; padding:26px 18px 44px; }
  .hero { display:flex; align-items:flex-end; justify-content:space-between; gap:18px; padding:0 0 18px; border-bottom:1px solid var(--line); }
  .hero h1 { font-size:22px; line-height:1.15; margin:0 0 8px; font-weight:680; letter-spacing:0; color:var(--fg); }
  .hero p { margin:0; color:var(--mut); max-width:620px; }
  .stats { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
  .stat { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:7px 10px; min-width:92px; text-align:right; }
  .stat strong { display:block; font-size:18px; line-height:1.05; color:var(--fg); }
  .stat span { display:block; color:var(--mut); font-size:11px; margin-top:2px; }
  .day { margin-top:24px; }
  .dayHead { display:flex; justify-content:space-between; align-items:center; color:var(--mut); margin:0 0 12px; text-transform:uppercase; }
  .dayHead h1 { margin:0; font-size:12px; font-weight:700; letter-spacing:.08em; color:var(--soft); }
  .dayHead span { font-size:12px; }
  .project { margin:0 0 18px; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .projectHead { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:12px 14px; border-bottom:1px solid var(--line); }
  .project h2 { margin:0; font-size:15px; font-weight:650; color:var(--fg); }
  .path { margin-top:2px; color:var(--mut); font-size:11.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:610px; }
  .projectMeta { color:var(--mut); font-size:11.5px; white-space:nowrap; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:1px; background:var(--line); }
  .card { background:var(--card); padding:13px 14px 12px; min-width:0; }
  .cardTop { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
  .cardTitle { font-size:14px; font-weight:640; line-height:1.35; min-width:0; }
  .meta { margin-top:4px; color:var(--mut); font-size:11.5px; }
  .badge { flex-shrink:0; border:1px solid var(--line2); border-radius:999px; padding:2px 7px; color:var(--soft); font-size:11px; line-height:1.45; white-space:nowrap; }
  .badge.tool, .badge.waiting { color:var(--warn); border-color:rgba(232,200,120,.42); }
  .badge.handoff { color:var(--accent); border-color:rgba(143,214,172,.42); }
  .badge.empty, .badge.minimal { color:var(--mut); }
  .quote { margin-top:10px; color:var(--fg); overflow:hidden; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; }
  .quote span { display:block; color:var(--mut); font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; margin-bottom:2px; }
  .quote.last { border-left:2px solid var(--coral); padding-left:9px; }
  .actions { display:flex; gap:7px; flex-wrap:wrap; margin-top:12px; }
  .a { border:1px solid var(--line2); background:var(--btn); color:var(--fg); border-radius:6px; padding:5px 9px; font:inherit; font-size:11.5px; cursor:pointer; }
  .a.primary { border-color:rgba(143,214,172,.5); }
  .a:hover { background:var(--hover); border-color:#666; }
  .empty { padding:30px 16px; color:var(--mut); text-align:center; }
  @media (max-width:700px) {
    .hero, .projectHead { align-items:flex-start; flex-direction:column; }
    .stats { justify-content:flex-start; }
    .stat { text-align:left; }
    .projectMeta { white-space:normal; }
  }
</style>
</head>
<body>
  <main class="shell">
    <header class="hero">
      <div>
        <h1>Start My Day</h1>
        <p>Recent Claude Code sessions, locally reconstructed from readable conversation turns. No AI summary, no network, no transcript edits.</p>
      </div>
      <div class="stats">
        <div class="stat"><strong>${summaries.length}</strong><span>recent</span></div>
        <div class="stat"><strong>${projects}</strong><span>projects</span></div>
        <div class="stat"><strong>${meaningful}</strong><span>meaningful</span></div>
        <div class="stat"><strong>${needsAttention}</strong><span>needs look</span></div>
      </div>
    </header>
    <div id="list">${sections || '<div class="empty">No sessions found.</div>'}</div>
  </main>
<script>
  document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    window.open('/open/' + encodeURIComponent(b.dataset.open), '_blank');
  });
  document.querySelectorAll('[data-code]').forEach(b => b.onclick = () => {
    if (!b.dataset.code) return;
    b.disabled = true; b.textContent = '…';
    fetch('/code', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cwd: b.dataset.code }) })
      .finally(() => { b.disabled = false; b.textContent = 'Code'; });
  });
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/') {
      const sessions = await sessionSummaries();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(listHtml(sessions));
      return;
    }
    if (req.url.startsWith('/open/')) {
      const id = decodeURIComponent(req.url.slice('/open/'.length));
      const sessions = await lastSessions();
      const s = sessions.find((x) => x.id === id);
      if (!s) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Session not found in the last ' + LAST_N + ' — refresh the list.');
        return;
      }
      const convo = await extractConversation(s.file);
      const entry = { session: s, convo, title: displayTitle(s), folder: folderLabel(s.cwd) };
      // The viewer's script assumes a VS Code webview host (acquireVsCodeApi
      // global); shim it to a no-op before that script runs so the exact
      // same viewer markup renders in a plain browser tab unmodified.
      const html = viewer.html(entry).replace(
        '<script nonce=',
        '<script>window.acquireVsCodeApi=function(){return{postMessage(){},setState(){},getState(){}};};</script><script nonce='
      );
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }
    if (req.url === '/code' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        let cwd = '';
        try {
          cwd = JSON.parse(body || '{}').cwd || '';
        } catch {}
        // Only ever launch `code` on a folder that's actually one of a real
        // session's cwd values — never trust the POST body on its own (this
        // is an unauthenticated loopback endpoint that executes a process).
        const sessions = await lastSessions();
        if (cwd && sessions.some((s) => s.cwd === cwd)) {
          execFile('code', [cwd], () => {});
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('unknown folder');
        }
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(String((e && e.message) || e));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Claude Sessions — standalone viewer: http://${HOST}:${PORT}`);
});
