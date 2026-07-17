// Global search panel — a webview view that sits above the sessions tree.
// Exact-phrase search over the chat text of ALL sessions (see search-index.js).
// The webview only renders; queries run here in the extension host, and a
// clicked result opens the conversation viewer at that message via the
// viewer's own search machinery.
//
// Extension point: a second search mode (AI/semantic over the same index) can
// plug into onMessage('query') next to the precise path when it lands.

const vscode = require('vscode');
const path = require('path');
const { buildSearchIndex, searchIndex, MIN_QUERY_LEN } = require('./search-index');
const { SEARCH_SVG } = require('./icons');

const INDEX_FRESH_MS = 30 * 1000; // re-stat transcripts at most this often

class SearchViewProvider {
  constructor(context, treeProvider, viewer) {
    this.context = context;
    this.treeProvider = treeProvider;
    this.viewer = viewer;
    this.view = null;
    this.indexed = null;
    this.indexing = null;
    this.lastBuildMs = 0;
  }

  get cacheFile() {
    return path.join(this.context.globalStorageUri.fsPath, 'search-index.json');
  }

  get config() {
    const c = vscode.workspace.getConfiguration('claudeSessionsViewer');
    return {
      theme: c.get('theme', 'system'),
      userLabel: c.get('userLabel', 'USER'),
      agentLabel: c.get('agentLabel', 'CLAUDE'),
    };
  }

  postTheme() {
    if (this.view) this.view.webview.postMessage({ type: 'theme', theme: this.config.theme });
  }

  // Title-bar button / command entry: expand the view and focus the input.
  async reveal() {
    await vscode.commands.executeCommand('claudeSessions.search.focus');
    if (this.view) this.view.webview.postMessage({ type: 'focus' });
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg).catch(() => {}));
    view.onDidChangeVisibility(() => {
      if (view.visible) view.webview.postMessage({ type: 'focus' });
    });
  }

  // In-memory index, refreshed by a cheap stat pass at most every
  // INDEX_FRESH_MS; the first build streams every transcript once (progress
  // shown), later passes re-read only changed files.
  freshIndex() {
    if (this.indexing) return this.indexing;
    if (this.indexed && Date.now() - this.lastBuildMs < INDEX_FRESH_MS) return Promise.resolve(this.indexed);
    const firstBuild = !this.indexed;
    this.indexing = buildSearchIndex(this.cacheFile, (done, total) => {
      if (firstBuild && this.view && (done % 25 === 0 || done === total)) {
        this.view.webview.postMessage({ type: 'status', text: `Indexing sessions ${done}/${total}…` });
      }
    })
      .then((ix) => {
        this.indexed = ix;
        this.lastBuildMs = Date.now();
        return ix;
      })
      .finally(() => {
        this.indexing = null;
      });
    return this.indexing;
  }

  // Session metadata joined from the tree's own index: same dedup by id,
  // same automation filter, same custom titles and folder labels.
  async sessionNodes() {
    await this.treeProvider.ensureLoaded();
    const map = new Map();
    for (const n of this.treeProvider.allSessions()) map.set(n.session.id, n);
    return map;
  }

  async onMessage(msg) {
    if (msg.type === 'query') {
      const phrase = String(msg.q || '');
      const post = (payload) => {
        if (this.view) this.view.webview.postMessage(Object.assign({ type: 'results', seq: msg.seq }, payload));
      };
      if (phrase.trim().length < MIN_QUERY_LEN) {
        post({ groups: [], totalMatches: 0, idle: true });
        return;
      }
      const [indexed, nodes] = await Promise.all([this.freshIndex(), this.sessionNodes()]);
      const hits = searchIndex(indexed, phrase);
      const cfg = this.config;
      const groups = [];
      let totalMatches = 0;
      for (const h of hits) {
        const node = nodes.get(h.id);
        // Only sessions the tree shows: automation stays hidden, and of
        // duplicated transcripts (same id copied across project dirs) only
        // the freshest file counts, so one hit never lists twice.
        if (!node || node.session.file !== h.file) continue;
        totalMatches += h.total;
        groups.push({
          id: h.id,
          total: h.total,
          folder: node.group.label,
          title: this.treeProvider.displayTitle(node.session),
          ts: node.session.effTs || node.session.lastTs || '',
          snippets: h.snippets,
        });
      }
      groups.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
      post({ groups, totalMatches, userLabel: cfg.userLabel, agentLabel: cfg.agentLabel });
      return;
    }
    if (msg.type === 'open') {
      const node = (await this.sessionNodes()).get(String(msg.id || ''));
      if (!node) {
        vscode.window.showWarningMessage('Claude Sessions: this session is no longer in the index.');
        return;
      }
      this.treeProvider.rememberSession(node);
      await this.viewer.open(node.session, this.treeProvider.displayTitle(node.session), node.group.label, {
        beside: true,
        find: { query: String(msg.q || ''), ts: msg.ts || null },
      });
    }
  }

  html() {
    const nonce = Math.random().toString(36).slice(2);
    const cfg = this.config;
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin:0; font-family: var(--vscode-font-family), -apple-system, 'SF Pro Text', 'Segoe UI', sans-serif;
    font-size: var(--vscode-font-size, 13px); line-height:1.45; }
  body.sys { --bg:var(--vscode-sideBar-background, var(--vscode-editor-background)); --fg:var(--vscode-foreground);
    --mut:var(--vscode-descriptionForeground,#8a8a8a); --line:var(--vscode-panel-border,#3c3c3c);
    --hover:var(--vscode-list-hoverBackground,#2a2d2e); --chip:var(--vscode-badge-background,#4d4d4d);
    --chipfg:var(--vscode-badge-foreground,#fff);
    --inp:var(--vscode-input-background,#3c3c3c); --inpfg:var(--vscode-input-foreground,#ccc);
    --focus:var(--vscode-focusBorder,#007fd4); --user-strong:#456579; --agent-strong:#55518f; --mark:#ffe98f; --markfg:#333; }
  body.dark { --bg:#1e1e1e; --fg:#ccc; --mut:#8a8a8a; --line:#3c3c3c; --hover:#2a2d2e; --chip:#4d4d4d; --chipfg:#fff;
    --inp:#3c3c3c; --inpfg:#ccc; --focus:#007fd4; --user-strong:#93b5c6; --agent-strong:#aaa6dc; --mark:#6f5a18; --markfg:#ffd9a0; }
  body.light { --bg:#f7f7f7; --fg:#333; --mut:#767676; --line:#dedede; --hover:#e8e8e8; --chip:#dadada; --chipfg:#333;
    --inp:#fff; --inpfg:#333; --focus:#007fd4; --user-strong:#456579; --agent-strong:#55518f; --mark:#ffe98f; --markfg:#333; }
  body { background:var(--bg); color:var(--fg); }
  .box { padding:6px 8px 4px; display:flex; align-items:center; gap:6px; }
  .box .icon { color:var(--mut); flex-shrink:0; display:inline-flex; }
  #q { flex:1; min-width:0; background:var(--inp); color:var(--inpfg); border:1px solid var(--line); border-radius:3px;
    padding:3px 7px; font:inherit; outline:none; }
  #q:focus { border-color:var(--focus); }
  .summary { padding:3px 10px 5px; font-size:11px; color:var(--mut); border-bottom:1px solid var(--line); min-height:15px; }
  .summary b { color:var(--fg); }
  .sess { display:flex; align-items:center; gap:5px; padding:3px 8px; cursor:pointer; white-space:nowrap; overflow:hidden; }
  .sess:hover { background:var(--hover); }
  .sess .chev { width:11px; flex-shrink:0; color:var(--mut); font-size:9px; }
  .sess .folder { font-weight:600; flex-shrink:0; }
  .sess .stitle { color:var(--mut); overflow:hidden; text-overflow:ellipsis; font-size:12px; }
  .sess .date { color:var(--mut); font-size:10.5px; flex-shrink:0; }
  .sess .count { margin-left:auto; flex-shrink:0; background:var(--chip); color:var(--chipfg); border-radius:8px;
    font-size:10px; padding:0 7px; }
  .snips.closed { display:none; }
  .snip { display:flex; gap:6px; padding:2px 8px 2px 22px; cursor:pointer; font-size:12px; line-height:1.4; }
  .snip:hover { background:var(--hover); }
  .snip .who { flex-shrink:0; max-width:52px; overflow:hidden; text-overflow:ellipsis; font-weight:700; font-size:10px; padding-top:2px; }
  .snip .who.u { color:var(--user-strong); }
  .snip .who.a { color:var(--agent-strong); }
  .snip .time { flex-shrink:0; color:var(--mut); font-size:10px; padding-top:2px; }
  .snip .text { color:var(--mut); overflow:hidden; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
  .snip mark { background:var(--mark); color:var(--markfg); border-radius:2px; padding:0 1px; }
  .morehits { padding:1px 8px 3px 22px; font-size:10.5px; color:var(--mut); font-style:italic; }
  .empty { padding:14px 10px; color:var(--mut); font-size:11.5px; text-align:center; }
</style>
</head>
<body class="${cfg.theme === 'system' ? 'sys' : cfg.theme}">
  <div class="box"><span class="icon">${SEARCH_SVG}</span>
    <input id="q" type="text" placeholder="Search all sessions (exact phrase)" aria-label="Search all sessions"></div>
  <div class="summary" id="summary">Type at least ${MIN_QUERY_LEN} characters to search.</div>
  <div id="results"></div>
<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
let seq = 0;
let timer = 0;

function send() {
  seq++;
  vscodeApi.postMessage({ type:'query', seq, q: $('q').value });
}
$('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(send, 200); });
$('q').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('q').value = ''; send(); } });

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-GB', { day:'2-digit', month:'short' });
}
function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'theme') { document.body.className = m.theme === 'system' ? 'sys' : m.theme; return; }
  if (m.type === 'focus') { $('q').focus(); $('q').select(); return; }
  if (m.type === 'status') { $('summary').textContent = m.text; return; }
  if (m.type !== 'results' || m.seq !== seq) return;
  render(m);
});

function render(m) {
  const res = $('results');
  res.innerHTML = '';
  if (m.idle) {
    $('summary').textContent = 'Type at least ${MIN_QUERY_LEN} characters to search.';
    return;
  }
  if (!m.groups.length) {
    $('summary').innerHTML = 'No matches.';
    res.innerHTML = '<div class="empty">Nothing found in what you or the agent said.<br>Searches are exact-phrase.</div>';
    return;
  }
  $('summary').innerHTML = '<b>' + m.totalMatches + '</b> match' + (m.totalMatches === 1 ? '' : 'es') +
    ' in <b>' + m.groups.length + '</b> session' + (m.groups.length === 1 ? '' : 's');
  const q = $('q').value;
  m.groups.forEach((g, gi) => {
    const head = document.createElement('div');
    head.className = 'sess';
    head.innerHTML = '<span class="chev">' + (gi === 0 ? '▼' : '▶') + '</span>' +
      '<span class="folder">' + esc(g.folder) + '</span>' +
      '<span class="stitle">' + esc(g.title) + '</span>' +
      '<span class="date">' + fmtDate(g.ts) + '</span>' +
      '<span class="count">' + g.total + '</span>';
    const snips = document.createElement('div');
    snips.className = 'snips' + (gi === 0 ? '' : ' closed');
    head.onclick = () => {
      snips.classList.toggle('closed');
      head.querySelector('.chev').textContent = snips.classList.contains('closed') ? '▶' : '▼';
    };
    for (const s of g.snippets) {
      const d = document.createElement('div');
      d.className = 'snip';
      d.title = 'Open the conversation at this message';
      d.innerHTML = '<span class="who ' + s.r + '">' + esc(s.r === 'u' ? m.userLabel : m.agentLabel) + '</span>' +
        '<span class="time">' + (fmtTime(s.ts) || '·') + '</span>' +
        '<span class="text">' + esc(s.before) + '<mark>' + esc(s.hit) + '</mark>' + esc(s.after) + '</span>';
      d.onclick = () => vscodeApi.postMessage({ type:'open', id: g.id, q, ts: s.ts });
      snips.appendChild(d);
    }
    if (g.snippets.length < g.total) {
      const more = document.createElement('div');
      more.className = 'morehits';
      more.textContent = '+' + (g.total - g.snippets.length) + ' more in this session — open it to walk all matches';
      snips.appendChild(more);
    }
    res.appendChild(head);
    res.appendChild(snips);
  });
}
</script>
</body>
</html>`;
  }
}

module.exports = { SearchViewProvider };
