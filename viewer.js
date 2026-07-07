// Conversation viewer webview — renders a session read-only, exactly per the
// approved POC v3 design. Nothing runs unless the ▶ button is pressed.

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const { extractConversation, conversationToText } = require('./conversation');

const RENDER_WINDOW = 200; // big sessions: render latest N first, "render all" banner

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shortHome(p) {
  const home = os.homedir();
  return p && p.startsWith(home) ? '~' + p.slice(home.length) : p || '?';
}

function fmt(ts) {
  if (!ts) return '?';
  const d = new Date(ts);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

class ConversationViewer {
  constructor(context) {
    this.context = context;
    this.panels = new Map(); // sessionId -> {panel, convo, session, title, folder}
    this.opening = new Map(); // sessionId -> in-flight open() promise
  }

  get config() {
    const c = vscode.workspace.getConfiguration('claudeSessionsViewer');
    return {
      theme: c.get('theme', 'system'),
      userLabel: c.get('userLabel', 'USER'),
      liveRefresh: c.get('liveRefresh.enabled', false),
    };
  }

  open(session, title, folderLabel, opts = {}) {
    const existing = this.panels.get(session.id);
    if (existing) {
      existing.panel.reveal(opts.beside ? vscode.ViewColumn.Beside : undefined);
      return Promise.resolve();
    }
    const inFlight = this.opening.get(session.id);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const convo = await extractConversation(session.file);
      const panel = vscode.window.createWebviewPanel(
        'claudeSessionsViewer.conversation',
        `✳ ${title}`,
        opts.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      const entry = { panel, convo, session, title, folder: folderLabel };
      this.panels.set(session.id, entry);

      const fsMod = require('fs');
      let listener = null;
      if (this.config.liveRefresh) {
        // Optional live refresh: while the session keeps writing, re-extract
        // and push updated messages into the webview.
        let refreshing = false;
        listener = async () => {
          if (refreshing) return;
          refreshing = true;
          try {
            entry.convo = await extractConversation(session.file);
            panel.webview.postMessage({
              type: 'update',
              messages: entry.convo.messages,
              firstTs: entry.convo.firstTs,
              lastTs: entry.convo.lastTs,
            });
          } catch {}
          refreshing = false;
        };
        fsMod.watchFile(session.file, { interval: 3000 }, listener);
      }

      panel.onDidDispose(() => {
        if (listener) fsMod.unwatchFile(session.file, listener);
        this.panels.delete(session.id);
      });
      panel.webview.onDidReceiveMessage((msg) => this.onMessage(entry, msg));
      panel.webview.html = this.html(entry);
    })();

    this.opening.set(session.id, promise);
    return promise.finally(() => this.opening.delete(session.id));
  }

  async onMessage(entry, msg) {
    const { session, convo, title, folder } = entry;
    const textOpts = (m) => ({
      title,
      folder,
      userLabel: this.config.userLabel,
      names: m.names !== false,
      filter: m.filter || 'all',
      withTools: !!m.tools,
    });
    switch (msg.type) {
      case 'resume': {
        const terminal = vscode.window.createTerminal({ name: `claude · ${folder}`, cwd: session.cwd });
        terminal.show();
        terminal.sendText(`claude --resume ${session.id}`, true);
        break;
      }
      case 'copy': {
        await vscode.env.clipboard.writeText(conversationToText(convo, textOpts(msg)));
        vscode.window.showInformationMessage(
          `Copied entire conversation (${convo.messages.filter((m) => m.role !== 'tool').length} messages)`
        );
        break;
      }
      case 'export': {
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(os.homedir(), `${title.replace(/[/\\:]/g, '-').slice(0, 60)}.md`)),
          filters: { Markdown: ['md'] },
        });
        if (uri) {
          const { writeFileSync } = require('fs');
          writeFileSync(uri.fsPath, conversationToText(convo, textOpts(msg)));
          vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
        }
        break;
      }
      case 'reveal':
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(session.file));
        break;
      case 'setConfig': {
        const c = vscode.workspace.getConfiguration('claudeSessionsViewer');
        if (msg.theme) await c.update('theme', msg.theme, vscode.ConfigurationTarget.Global);
        if (msg.userLabel !== undefined)
          await c.update('userLabel', msg.userLabel || 'USER', vscode.ConfigurationTarget.Global);
        break;
      }
    }
  }

  html(entry) {
    const { session, convo, title, folder } = entry;
    const cfg = this.config;
    const nonce = Math.random().toString(36).slice(2);
    const data = JSON.stringify({
      messages: convo.messages,
      userLabel: cfg.userLabel,
      theme: cfg.theme,
      window: RENDER_WINDOW,
    }).replace(/</g, '\\u003c');
    const nMsgs = convo.messages.filter((m) => m.role !== 'tool').length;
    const sizeKb = Math.round((session.size || 0) / 1024) || '?';

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { --accent:#d97757; margin:0; font:13px/1.55 -apple-system,'SF Pro Text','Segoe UI',sans-serif; }
  body.sys { --bg:var(--vscode-editor-background); --panel:var(--vscode-sideBar-background,#252526);
    --line:var(--vscode-panel-border,#3c3c3c); --fg:var(--vscode-foreground);
    --mut:var(--vscode-descriptionForeground,#8a8a8a); --chip:var(--vscode-badge-background,#333);
    --btn2:var(--vscode-button-secondaryBackground,#3a3d41); --hov:var(--vscode-list-hoverBackground,#2a2d2e);
    --user-bub:color-mix(in srgb, #d97757 16%, var(--vscode-editor-background));
    --ai-bub:var(--vscode-list-hoverBackground,#2a2d2e); --sep:#5a5a5a; }
  body.dark { --bg:#1e1e1e; --panel:#252526; --line:#3c3c3c; --fg:#ccc; --mut:#8a8a8a;
    --user-bub:#3a2620; --ai-bub:#2a2d2e; --chip:#333; --btn2:#3a3d41; --hov:#2a2d2e; --sep:#5a5a5a; }
  body.light { --bg:#fff; --panel:#f3f3f3; --line:#e0e0e0; --fg:#333; --mut:#767676;
    --user-bub:#fbeee8; --ai-bub:#f4f4f4; --chip:#ececec; --btn2:#e4e4e4; --hov:#ececec; --sep:#bbb; --accent:#c15f3c; }
  body { background:var(--bg); color:var(--fg); display:flex; flex-direction:column; height:100vh; }
  .vhead { padding:7px 12px; border-bottom:1px solid var(--line); background:var(--panel); flex-shrink:0; }
  .vrow { display:flex; align-items:center; gap:8px; }
  .spark { color:var(--accent); }
  .title { font-size:13px; font-weight:600; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ibtn { border:1px solid transparent; background:transparent; color:var(--mut); font-size:14px; cursor:pointer; padding:2px 6px; border-radius:4px; }
  .ibtn:hover { background:var(--btn2); color:var(--fg); }
  .ibtn.play { color:var(--accent); border-color:color-mix(in srgb, var(--accent) 55%, transparent);
    background:color-mix(in srgb, var(--accent) 10%, transparent); font-weight:700; }
  .ibtn.play:hover { color:#fff; background:var(--accent); border-color:var(--accent); }
  .dates { color:var(--mut); font-size:11px; margin-top:3px; }
  .details { display:none; color:var(--mut); font-size:11.5px; margin-top:4px; }
  .details.open { display:block; }
  .details code { background:var(--chip); border-radius:3px; padding:0 4px; font-size:11px; }
  .gear-pop { position:absolute; top:36px; right:10px; background:var(--panel); border:1px solid var(--line);
    border-radius:6px; padding:10px 12px; font-size:12px; z-index:5; display:none; width:235px; }
  .gear-pop.open { display:block; }
  .gear-pop .row { display:flex; align-items:center; gap:6px; margin:5px 0; }
  .gear-pop .lbl { color:var(--mut); width:78px; flex-shrink:0; }
  .gear-pop .opt { border:1px solid var(--line); border-radius:9px; padding:0 9px; cursor:pointer; color:var(--mut); }
  .gear-pop .opt.on { border-color:var(--accent); color:var(--accent); }
  .gear-pop input[type=text] { background:var(--bg); border:1px solid var(--line); color:var(--fg);
    border-radius:4px; padding:2px 6px; width:100px; font-size:12px; }
  .fbar { display:flex; gap:6px; align-items:center; padding:5px 12px; border-bottom:1px solid var(--line);
    font-size:11.5px; flex-wrap:wrap; flex-shrink:0; }
  .fchip { border:1px solid var(--line); background:transparent; color:var(--mut); border-radius:11px;
    padding:1px 11px; cursor:pointer; font-size:11.5px; }
  .fchip.on { background:var(--chip); color:var(--fg); border-color:var(--sep); }
  .fbar .right { margin-left:auto; display:flex; gap:12px; align-items:center; color:var(--mut); }
  .fbar label { cursor:pointer; user-select:none; }
  .chat { flex:1; overflow-y:auto; padding:14px 16px; display:flex; flex-direction:column; gap:9px; }
  .banner { text-align:center; background:var(--chip); color:var(--mut); border-radius:6px; padding:5px 10px; font-size:11.5px; }
  .banner b { color:var(--fg); cursor:pointer; text-decoration:underline; }
  .day { align-self:center; color:var(--mut); font-size:11px; letter-spacing:.06em;
    border-bottom:1px solid var(--line); padding:0 10px 2px; }
  .msg { max-width:76%; padding:7px 11px; border-radius:10px; white-space:pre-wrap; overflow-wrap:break-word; }
  .who { font-size:10.5px; color:var(--mut); margin-bottom:2px; letter-spacing:.04em; }
  .msg.user { align-self:flex-end; background:var(--user-bub); border-right:3px solid var(--accent); border-bottom-right-radius:3px; }
  .msg.assistant { align-self:flex-start; background:var(--ai-bub); border-bottom-left-radius:3px; }
  body[data-names="on"] .msg.assistant .who::before { content:"✳ "; color:var(--accent); }
  body[data-names="off"] .who { display:none; }
  body[data-mode="plain"] .msg { max-width:100%; align-self:stretch; background:transparent;
    border:none; border-left:2px solid var(--line); border-radius:0; padding:2px 12px; }
  body[data-mode="plain"] .msg.user { border-left-color:var(--accent); }
  .more { color:var(--accent); font-size:11.5px; cursor:pointer; margin-top:4px; display:inline-block; }
  .tool { align-self:center; font:11px ui-monospace,Menlo,monospace; color:var(--mut);
    background:var(--chip); border-radius:10px; padding:1px 10px; }
  body[data-mode="plain"] .tool { align-self:flex-start; background:transparent; padding-left:12px; }
  .jump { position:fixed; right:16px; bottom:14px; background:var(--btn2); color:var(--fg);
    border:1px solid var(--line); border-radius:50%; width:28px; height:28px; cursor:pointer;
    display:flex; align-items:center; justify-content:center; }
  .empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--mut); gap:6px; }
</style>
</head>
<body class="sys" data-mode="chat" data-names="on">
  <div class="vhead">
    <div class="vrow">
      <span class="spark">✳</span><span class="title">${esc(title)}</span>
      <button class="ibtn play" id="resume" title="Resume in terminal — the only action that runs anything">▶</button>
      <button class="ibtn" id="copy" title="Copy entire conversation (respects filters and toggles)">⧉</button>
      <button class="ibtn" id="export" title="Save conversation as .md">⬇</button>
      <button class="ibtn" id="reveal" title="Reveal raw .jsonl in Finder">{ }</button>
      <button class="ibtn" id="gear" title="Viewer settings">⚙</button>
      <button class="ibtn" id="fold" title="Session details">⌄</button>
    </div>
    <div class="dates" id="dates">created ${fmt(convo.firstTs)} → last message ${fmt(convo.lastTs)}</div>
    <div class="details" id="details">📁 ${esc(folder)} · session <code>${esc(session.id)}</code> · ${nMsgs} messages · transcript ${sizeKb} KB · started in <code>${esc(shortHome(session.cwd))}</code></div>
    <div class="gear-pop" id="gearpop">
      <div class="row"><span class="lbl">Theme</span>
        <span class="opt" data-th="system">System</span><span class="opt" data-th="light">Light</span><span class="opt" data-th="dark">Dark</span></div>
      <div class="row"><span class="lbl">Your label</span><input type="text" id="ulabel"></div>
      <div class="row" style="color:var(--mut);font-size:11px">System follows the VS Code theme. Also in Settings → Claude Sessions Viewer.</div>
    </div>
  </div>
  <div class="fbar">
    <button class="fchip on" data-f="all">All</button>
    <button class="fchip" data-f="user" id="chipUser">USER only</button>
    <button class="fchip" data-f="assistant">CLAUDE only</button>
    <span class="right">
      <label><input type="checkbox" id="mode"> plain flow</label>
      <label><input type="checkbox" id="names" checked> names</label>
      <label><input type="checkbox" id="tools"> tools</label>
    </span>
  </div>
  <div class="chat" id="chat"></div>
  <div class="jump" id="jump" title="Jump to last message">↓</div>

<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
const DATA = ${data};
const DISPLAY_CAP = 1500;
let filter = 'all', renderAll = DATA.messages.length <= DATA.window * 1.2;
const $ = id => document.getElementById(id);
const escHtml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;');

document.body.className = DATA.theme === 'system' ? 'sys' : DATA.theme;
$('ulabel').value = DATA.userLabel;
document.querySelectorAll('[data-th]').forEach(b => {
  if (b.dataset.th === DATA.theme) b.classList.add('on');
});

function dayOf(ts){ if(!ts) return null; const d = new Date(ts);
  return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}).toUpperCase(); }

function render(keepScroll){
  const chatEl = $('chat');
  const wasAtBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60;
  const prevScroll = chatEl.scrollTop;
  const label = ($('ulabel').value || 'USER').toUpperCase();
  $('chipUser').textContent = label + ' only';
  const chat = $('chat');
  chat.innerHTML = '';
  const msgs = DATA.messages;
  if (!msgs.some(m => m.role !== 'tool')) {
    chat.innerHTML = '<div class="empty"><div style="font-size:26px;color:var(--accent);opacity:.6">✳</div>' +
      '<div>No readable conversation in this transcript</div>' +
      '<div style="font-size:11.5px">(only tool traffic / system records — { } opens the raw file)</div></div>';
    return;
  }
  let start = 0;
  if (!renderAll) {
    start = Math.max(0, msgs.length - DATA.window);
    chat.insertAdjacentHTML('beforeend',
      '<div class="banner">big session — latest ' + (msgs.length - start) +
      ' rendered for speed · <b id="rall">render all ' + msgs.length + '</b> (⌘A then selects all) · ⧉ always copies all</div>');
  }
  let lastDay = null;
  const showTools = $('tools').checked;
  const frag = [];
  for (let i = start; i < msgs.length; i++) {
    const m = msgs[i];
    const day = dayOf(m.ts);
    if (day && day !== lastDay && filter === 'all') { frag.push('<div class="day">' + day + '</div>'); lastDay = day; }
    if (m.role === 'tool') {
      if (showTools && filter === 'all') frag.push('<div class="tool">' + escHtml(m.text) + '</div>');
      continue;
    }
    if (filter !== 'all' && m.role !== filter) continue;
    const who = m.role === 'user' ? escHtml(label) : 'CLAUDE';
    let text = m.text, more = '';
    if (text.length > DISPLAY_CAP) {
      more = '<span class="more" data-i="' + i + '">show full message ▾</span>';
      text = text.slice(0, DISPLAY_CAP) + '…';
    }
    frag.push('<div class="msg ' + m.role + '"><div class="who">' + who + '</div>' + escHtml(text) + more + '</div>');
  }
  chat.insertAdjacentHTML('beforeend', frag.join(''));
  const rall = $('rall');
  if (rall) rall.onclick = () => { renderAll = true; render(); };
  chat.querySelectorAll('.more').forEach(el => el.onclick = () => {
    const m = DATA.messages[+el.dataset.i];
    el.parentElement.innerHTML = '<div class="who">' +
      escHtml(el.parentElement.querySelector('.who').textContent) + '</div>' + escHtml(m.text);
  });
  if (keepScroll && !wasAtBottom) chat.scrollTop = prevScroll;
  else chat.scrollTop = chat.scrollHeight; // WhatsApp: open at last message
}

function fmtTs(ts){ if(!ts) return '?'; const d = new Date(ts);
  return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) + ' ' +
         d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }

window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'update') {
    DATA.messages = m.messages;
    $('dates').textContent = 'created ' + fmtTs(m.firstTs) + ' → last message ' + fmtTs(m.lastTs) + ' · live';
    render(true);
  }
});

const state = () => ({ filter, names: $('names').checked, tools: $('tools').checked });
$('resume').onclick = () => vscodeApi.postMessage({ type:'resume' });
$('copy').onclick   = () => vscodeApi.postMessage(Object.assign({ type:'copy' }, state()));
$('export').onclick = () => vscodeApi.postMessage(Object.assign({ type:'export' }, state()));
$('reveal').onclick = () => vscodeApi.postMessage({ type:'reveal' });
$('gear').onclick   = () => $('gearpop').classList.toggle('open');
$('fold').onclick   = () => { const d = $('details'); d.classList.toggle('open');
  $('fold').textContent = d.classList.contains('open') ? '⌃' : '⌄'; };
$('jump').onclick   = () => { const c = $('chat'); c.scrollTop = c.scrollHeight; };
$('mode').onchange  = e => document.body.dataset.mode = e.target.checked ? 'plain' : 'chat';
$('names').onchange = e => document.body.dataset.names = e.target.checked ? 'on' : 'off';
$('tools').onchange = render;
$('ulabel').oninput = () => { render(); vscodeApi.postMessage({ type:'setConfig', userLabel: $('ulabel').value }); };
document.querySelectorAll('.fchip').forEach(b => b.onclick = () => {
  document.querySelectorAll('.fchip').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); filter = b.dataset.f; render();
});
document.querySelectorAll('[data-th]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-th]').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  document.body.className = b.dataset.th === 'system' ? 'sys' : b.dataset.th;
  vscodeApi.postMessage({ type:'setConfig', theme: b.dataset.th });
});
render();
</script>
</body>
</html>`;
  }
}

module.exports = { ConversationViewer };
