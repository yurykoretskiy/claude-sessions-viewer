// Conversation viewer webview. Read-only by default; the only action that
// runs anything is the explicit resume-in-terminal button.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fileURLToPath } = require('url');
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
      agentLabel: c.get('agentLabel', 'CLAUDE'),
      showNames: c.get('showNames', true),
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
    const cfg = this.config;
    const textOpts = (m) => ({
      title,
      folder,
      userLabel: m.userLabel || cfg.userLabel,
      agentLabel: m.agentLabel || cfg.agentLabel,
      names: m.names !== false,
      filter: m.filter || 'all',
      withTools: false,
    });
    switch (msg.type) {
      case 'resume': {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.id)) {
          vscode.window.showErrorMessage('Claude Sessions: refusing to resume — session id is not a valid UUID.');
          break;
        }
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
      case 'copyPath':
        await vscode.env.clipboard.writeText(session.file);
        vscode.window.showInformationMessage('Copied raw session JSONL path.');
        break;
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
      case 'openLink': {
        const href = String(msg.href || '').trim();
        if (!href) break;
        try {
          if (/^(https?:\/\/|mailto:)/i.test(href)) {
            await vscode.env.openExternal(vscode.Uri.parse(href));
          } else if (/^file:\/\//i.test(href)) {
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fileURLToPath(href)));
          } else {
            const expanded = href.startsWith('~/')
              ? path.join(os.homedir(), href.slice(2))
              : path.isAbsolute(href)
                ? href
                : path.resolve(session.cwd || path.dirname(session.file), href);
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(expanded));
          }
        } catch (e) {
          vscode.window.showErrorMessage(`Claude Sessions: could not open link — ${e.message}`);
        }
        break;
      }
      case 'openAttachment': {
        const id = String(msg.id || '');
        const attachment = convo.attachmentsById && convo.attachmentsById[id];
        if (!attachment || attachment.kind !== 'image' || !attachment.data) {
          vscode.window.showErrorMessage('Claude Sessions: image attachment is unavailable.');
          break;
        }
        const ext = attachment.mediaType === 'image/jpeg' ? 'jpg' : attachment.mediaType === 'image/webp' ? 'webp' : 'png';
        const safeSessionId = /^[0-9a-f-]+$/i.test(session.id) ? session.id : 'session';
        const dir = path.join(os.tmpdir(), 'claude-sessions-viewer', safeSessionId);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${id}.${ext}`);
        fs.writeFileSync(file, Buffer.from(attachment.data, 'base64'));
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
        break;
      }
      case 'setConfig': {
        const c = vscode.workspace.getConfiguration('claudeSessionsViewer');
        if (msg.theme) await c.update('theme', msg.theme, vscode.ConfigurationTarget.Global);
        if (msg.userLabel !== undefined)
          await c.update('userLabel', msg.userLabel || 'USER', vscode.ConfigurationTarget.Global);
        if (msg.agentLabel !== undefined)
          await c.update('agentLabel', msg.agentLabel || 'CLAUDE', vscode.ConfigurationTarget.Global);
        if (msg.showNames !== undefined)
          await c.update('showNames', !!msg.showNames, vscode.ConfigurationTarget.Global);
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
      agentLabel: cfg.agentLabel,
      showNames: cfg.showNames,
      theme: cfg.theme,
      window: RENDER_WINDOW,
      sessionId: session.id,
      rawPath: session.file,
      cwd: session.cwd,
    }).replace(/</g, '\\u003c');
    const nMsgs = convo.messages.filter((m) => m.role !== 'tool').length;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html { height:100%; overflow:hidden; }
  body { --agent-strong:#d97757; --user-strong:#4f9f62; margin:0; font:14px/1.48 -apple-system,'SF Pro Text','Segoe UI',sans-serif; }
  body.sys { --bg:var(--vscode-editor-background); --panel:var(--vscode-editor-background);
    --line:var(--vscode-panel-border,#3c3c3c); --fg:var(--vscode-foreground);
    --mut:var(--vscode-descriptionForeground,#8a8a8a); --chip:var(--vscode-badge-background,#333);
    --btn2:var(--vscode-button-secondaryBackground,#3a3d41); --sep:#5a5a5a;
    --user-bub:color-mix(in srgb, #dff3d7 72%, var(--vscode-editor-background));
    --agent-bub:color-mix(in srgb, #f3d6cc 72%, var(--vscode-editor-background));
    --rail-track:rgba(130,126,145,.18); --rail-fill:#8c849d; --rail-thumb:#8c849d;
    --code-bg:#282828; --code-fg:#eee; --mark:#ffe98f; }
  body.dark { --bg:#1e1e1e; --panel:#252526; --line:#3c3c3c; --fg:#ccc; --mut:#8a8a8a;
    --user-bub:#233427; --agent-bub:#3a2620; --chip:#333; --btn2:#3a3d41; --sep:#5a5a5a;
    --rail-track:rgba(142,134,162,.20); --rail-fill:#8f86a6; --rail-thumb:#8f86a6;
    --code-bg:#161616; --code-fg:#eee; --mark:#6f5a18; }
  body.light { --bg:#fff; --panel:#f7f7f7; --line:#dedede; --fg:#333; --mut:#767676;
    --user-bub:#dff3d7; --agent-bub:#f3d6cc; --chip:#f1f1f1; --btn2:#e9e9e9; --sep:#bbb;
    --rail-track:rgba(115,108,138,.16); --rail-fill:#8c849d; --rail-thumb:#8c849d;
    --agent-strong:#c15f3c; --user-strong:#4f9f62; --code-bg:#282828; --code-fg:#eee; --mark:#ffe98f; }
  body { background:var(--bg); color:var(--fg); display:flex; justify-content:center; height:100%; overflow:hidden; }
  .viewer { width:min(820px,100vw); height:100%; max-height:100%; overflow:hidden; background:var(--panel); border-left:1px solid var(--line); border-right:1px solid var(--line); display:flex; flex-direction:column; position:relative; }
  .vhead { padding:10px 16px 8px; border-bottom:1px solid var(--line); background:color-mix(in srgb, var(--panel) 97%, transparent); flex-shrink:0; position:relative; z-index:8; }
  .vrow { display:flex; align-items:center; gap:10px; }
  .title { font-size:17px; font-weight:680; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ibtn { width:30px; height:30px; border:1px solid transparent; background:transparent; color:var(--mut); font-size:14px; cursor:pointer; padding:0; border-radius:7px; }
  .ibtn:hover { background:var(--btn2); color:var(--fg); }
  .ibtn.terminal { width:38px; border-color:var(--line); font:12px/1 ui-monospace,Menlo,monospace; }
  .meta { color:var(--mut); font-size:12px; margin-top:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .settings { position:absolute; top:45px; right:14px; background:var(--panel); border:1px solid var(--line);
    border-radius:10px; padding:12px; font-size:12px; z-index:20; display:none; width:260px;
    box-shadow:0 8px 28px rgba(0,0,0,.16); }
  .settings.open { display:block; }
  .settings .row { display:flex; align-items:center; gap:8px; margin:8px 0; }
  .settings .lbl { color:var(--mut); width:72px; flex-shrink:0; }
  .settings .opt { border:1px solid var(--line); border-radius:9px; padding:0 9px; cursor:pointer; color:var(--mut); }
  .settings .opt.on { border-color:var(--agent-strong); color:var(--agent-strong); }
  .settings input[type=text] { background:var(--bg); border:1px solid var(--line); color:var(--fg);
    border-radius:6px; padding:4px 7px; min-width:0; flex:1; font-size:12px; }
  .controls { display:flex; gap:7px; align-items:center; padding:8px 16px; border-bottom:1px solid var(--line);
    font-size:12px; flex-wrap:wrap; flex-shrink:0; z-index:4; }
  .chip { border:1px solid var(--line); background:transparent; color:var(--mut); border-radius:11px;
    padding:2px 12px; cursor:pointer; font:inherit; font-size:12px; white-space:nowrap; }
  .chip.on { background:#d8c7df; color:var(--fg); border-color:#8d7c95; }
  .chip.search { padding-inline:15px; font-weight:650; border-color:color-mix(in srgb, var(--agent-strong) 35%, var(--line)); }
  .chip.search.open { color:var(--fg); background:color-mix(in srgb, var(--agent-strong) 14%, var(--bg)); border-color:var(--agent-strong); }
  .sep { width:1px; height:17px; background:var(--line); margin:0 2px; }
  .searchbar { display:none; grid-template-columns:1fr auto auto auto auto; align-items:center; gap:7px;
    padding:8px 16px; border-bottom:1px solid var(--line); flex-shrink:0; z-index:4; }
  .searchbar.open { display:grid; }
  .searchbox { min-width:120px; height:28px; border:1px solid var(--line); border-radius:999px;
    padding:0 11px; background:var(--bg); color:var(--fg); font:inherit; font-size:12px; }
  .count { color:var(--mut); font-size:12px; min-width:46px; text-align:right; }
  .tiny { width:26px; height:26px; border-radius:7px; border:1px solid var(--line); background:transparent; color:var(--mut); cursor:pointer; }
  .chatwrap { position:relative; flex:1; min-height:0; }
  .chat { height:100%; overflow-y:auto; padding:16px 54px 18px 18px; scroll-behavior:smooth; }
  .banner { text-align:center; background:var(--chip); color:var(--mut); border-radius:6px; padding:5px 10px; font-size:11.5px; }
  .banner b { color:var(--fg); cursor:pointer; text-decoration:underline; }
  .day { width:max-content; margin:12px auto; position:sticky; top:8px; z-index:2; color:var(--mut); font-size:11px;
    background:var(--panel); border:1px solid var(--line); border-radius:999px; padding:2px 10px;
    box-shadow:0 2px 9px rgba(0,0,0,.05); }
  .msg { max-width:78%; width:fit-content; margin:9px 0; padding:9px 12px; border-radius:13px; overflow-wrap:break-word; position:relative; }
  .msg.user { margin-left:auto; background:var(--user-bub); border-right:3px solid var(--user-strong); border-bottom-right-radius:4px; }
  .msg.assistant { margin-right:auto; background:var(--agent-bub); border-left:3px solid var(--agent-strong); border-bottom-left-radius:4px; }
  .who { font-size:11px; color:var(--mut); margin-bottom:3px; letter-spacing:.02em; font-weight:700; text-transform:uppercase; }
  .role-icon { display:inline-block; margin-right:4px; font-size:12px; line-height:1; vertical-align:-1px; }
  .msg.assistant .role-icon { color:var(--agent-strong); }
  .msg.user .role-icon { color:var(--user-strong); }
  body[data-names="off"] .who { display:none; }
  .body p { margin:0 0 7px; white-space:pre-wrap; }
  .body p:last-child { margin-bottom:0; }
  .body a { color:var(--vscode-textLink-foreground,#2677c9); text-decoration:underline; text-underline-offset:2px; }
  .body a:hover { color:var(--vscode-textLink-activeForeground,#1a8cff); }
  .body h3 { margin:4px 0 6px; font-size:15px; line-height:1.25; }
  .body ul, .body ol { margin:6px 0 6px 19px; padding:0; }
  code.inline { background:rgba(255,255,255,.48); border-radius:4px; padding:1px 4px;
    color:var(--agent-strong); font:12px ui-monospace,Menlo,monospace; }
  .quote { border-left:3px solid var(--agent-strong); background:rgba(255,255,255,.45); padding:6px 8px;
    border-radius:6px; margin:7px 0; color:var(--fg); }
  .attachments { display:flex; flex-wrap:wrap; gap:5px; margin:0 0 6px; }
  .attach { border:1px solid var(--line); color:var(--mut); background:rgba(255,255,255,.38);
    border-radius:999px; padding:2px 8px; font:inherit; font-size:11.5px; cursor:pointer; }
  .attach:hover { color:var(--fg); border-color:var(--agent-strong); }
  pre { margin:8px 0; padding:9px 10px; border-radius:8px; background:var(--code-bg); color:var(--code-fg);
    overflow-x:auto; font:12px/1.45 ui-monospace,Menlo,monospace; }
  .code-label { display:flex; justify-content:space-between; align-items:center; gap:8px; color:#b9b9b9; font-size:11px; margin-bottom:5px; }
  .copy-code { border:1px solid #555; border-radius:5px; background:transparent; color:#dcdcdc; font:inherit; font-size:11px; cursor:pointer; }
  .table-wrap { max-width:100%; overflow-x:auto; margin:8px 0; border:1px solid color-mix(in srgb, var(--line) 80%, var(--fg));
    border-radius:8px; background:rgba(255,255,255,.35); }
  table { border-collapse:collapse; min-width:470px; width:100%; font-size:12px; }
  th, td { border-bottom:1px solid var(--line); padding:5px 7px; text-align:left; vertical-align:top; }
  th { background:rgba(0,0,0,.05); font-weight:700; }
  mark { background:var(--mark); color:inherit; border-radius:3px; padding:0 1px; }
  mark.current { background:#ffc85a; box-shadow:0 0 0 2px rgba(217,119,87,.45); }
  .more { color:var(--agent-strong); font-size:12px; cursor:pointer; margin-top:6px; display:block; }
  .more:hover { text-decoration:underline; }
  .rail { position:absolute; right:13px; top:16px; bottom:72px; width:3px; border-radius:999px;
    background:var(--rail-track); pointer-events:none; z-index:5; }
  .rail-fill { position:absolute; top:0; left:0; width:3px; height:var(--rail-top,0%); border-radius:999px;
    background:var(--rail-fill); opacity:.72; }
  .rail-thumb { position:absolute; left:-3px; top:var(--rail-top,0%); width:9px; height:46px; margin-top:-23px;
    border-radius:999px; background:var(--rail-thumb); box-shadow:0 1px 7px rgba(0,0,0,.22); opacity:.82; }
  .pospill { position:absolute; right:28px; top:var(--rail-top,0%); transform:translateY(-50%);
    background:rgba(55,55,55,.94); color:#fff; border-radius:999px; padding:4px 9px; font-size:11px;
    line-height:1.2; white-space:nowrap; pointer-events:none; opacity:0; transition:opacity 160ms ease; z-index:6; }
  .chatwrap.scrolling .pospill, .chatwrap:hover .pospill { opacity:1; }
  .jump { position:absolute; right:20px; bottom:16px; background:var(--panel); color:var(--mut);
    border:1px solid var(--line); border-radius:50%; width:34px; height:34px; cursor:pointer;
    display:flex; align-items:center; justify-content:center; z-index:7; }
  .bottom-spacer { height:176px; flex:0 0 auto; }
  .empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--mut); gap:6px; }
  @media (max-width:620px) {
    .chat { padding-right:46px; }
    .msg { max-width:86%; }
    .title { font-size:15px; }
    .controls { gap:5px; }
  }
</style>
</head>
<body class="sys" data-names="${cfg.showNames ? 'on' : 'off'}">
<main class="viewer">
  <div class="vhead">
    <div class="vrow">
      <span class="title">${esc(title)}</span>
      <button class="ibtn terminal" id="resume" title="Resume in Claude terminal — the only action that runs anything">▶_</button>
      <button class="ibtn" id="copyPath" title="Copy full raw session JSONL path">⧉</button>
      <button class="ibtn" id="export" title="Save conversation as Markdown">⬇</button>
      <button class="ibtn" id="reveal" title="Open raw .jsonl">{}</button>
      <button class="ibtn" id="settingsBtn" title="Names">Aa</button>
    </div>
    <div class="meta" id="meta">${esc(folder)} · ${nMsgs} messages · ${esc(session.id)} · ${fmt(convo.firstTs)} → ${fmt(convo.lastTs)}</div>
    <div class="settings" id="settings">
      <div class="row"><label><input type="checkbox" id="showNames"${cfg.showNames ? ' checked' : ''}> Show names</label></div>
      <div class="row"><span class="lbl">You</span><input type="text" id="userLabel"></div>
      <div class="row"><span class="lbl">Agent</span><input type="text" id="agentLabel"></div>
      <div class="row"><span class="lbl">Theme</span>
        <span class="opt" data-th="system">System</span><span class="opt" data-th="light">Light</span><span class="opt" data-th="dark">Dark</span></div>
    </div>
  </div>
  <div class="controls">
    <button class="chip on" data-f="all">All</button>
    <button class="chip" data-f="user" id="chipUser">Me</button>
    <button class="chip" data-f="assistant" id="chipAgent">${esc(cfg.agentLabel)}</button>
    <span class="sep"></span>
    <button class="chip" id="collapseLong" title="Collapse long messages">Collapse long</button>
    <button class="chip" id="expandLong" title="Expand all long messages">Expand all</button>
    <span class="sep"></span>
    <button class="chip search" id="searchToggle">Search</button>
  </div>
  <div class="searchbar" id="searchbar">
    <input class="searchbox" id="search" placeholder="Search inside this session">
    <div class="count" id="count">0 / 0</div>
    <button class="tiny" id="prev" title="Previous match">↑</button>
    <button class="tiny" id="next" title="Next match">↓</button>
    <button class="tiny" id="clearSearch" title="Close search">x</button>
  </div>
  <div class="chatwrap" id="chatwrap">
    <div class="chat" id="chat"></div>
    <div class="rail" aria-hidden="true"><div class="rail-fill" id="railFill"></div><div class="rail-thumb" id="railThumb"></div></div>
    <div class="pospill" id="pospill">msg 1 / ${nMsgs}</div>
    <button class="jump" id="jump" title="Jump to last message">↓</button>
  </div>
</main>

<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
const DATA = ${data};
const DISPLAY_CAP = 700;
let filter = 'all';
let renderAll = DATA.messages.length <= DATA.window * 1.2;
let currentMatch = 0;
let matches = [];
let scrollTimer = 0;
const expandedMessages = new Set();
const $ = id => document.getElementById(id);
const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

document.body.className = DATA.theme === 'system' ? 'sys' : DATA.theme;
document.body.dataset.names = DATA.showNames ? 'on' : 'off';
$('userLabel').value = DATA.userLabel;
$('agentLabel').value = DATA.agentLabel;
document.querySelectorAll('[data-th]').forEach(b => {
  if (b.dataset.th === DATA.theme) b.classList.add('on');
});

function labels() {
  return {
    user: ($('userLabel').value || 'USER').toUpperCase(),
    agent: ($('agentLabel').value || 'CLAUDE').toUpperCase()
  };
}

function dayOf(ts){ if(!ts) return null; const d = new Date(ts);
  return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}).toUpperCase(); }

function fmtShortDay(day) {
  return day ? day.replace(' JUL ', ' Jul ') : '';
}

function visibleText(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || '';
}

function escAttr(s) {
  return escHtml(s).replace(/"/g, '&quot;');
}

function isOpenableHref(href) {
  const h = String(href || '');
  const lower = h.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:')) return true;
  if (lower.startsWith('file://') || h.startsWith('~/') || h.startsWith('/') || h.startsWith('./') || h.startsWith('../')) return true;
  const slash = h.indexOf('/');
  return slash > 0 && /^[A-Za-z0-9._-]+$/.test(h.slice(0, slash));
}

function anchorHtml(label, href) {
  const clean = String(href || '').trim();
  if (!isOpenableHref(clean)) return escHtml(label);
  return '<a href="#" data-href="' + escAttr(clean) + '">' + escHtml(label) + '</a>';
}

function renderInlineSegment(text) {
  const token = /(\\[[^\\]]+\\]\\([^\\s)]+\\)|(?:https?:\\/\\/|file:\\/\\/)[^\\s<>()]+)/g;
  let out = '';
  let last = 0;
  let match;
  while ((match = token.exec(text))) {
    out += escHtml(text.slice(last, match.index));
    const raw = match[0];
    const md = raw.match(/^\\[([^\\]]+)\\]\\(([^\\s)]+)\\)$/);
    if (md) {
      out += anchorHtml(md[1], md[2]);
    } else {
      const trailing = raw.match(/[.,;:!?]+$/);
      const punct = trailing ? trailing[0] : '';
      const href = punct ? raw.slice(0, -punct.length) : raw;
      out += anchorHtml(href, href) + escHtml(punct);
    }
    last = token.lastIndex;
  }
  out += escHtml(text.slice(last));
  return out;
}

function inlineMarkdown(text) {
  return String(text).split(/(\\\`[^\\\`]*\\\`)/g).map(part => {
    if (part.startsWith('\`') && part.endsWith('\`')) return '<code class="inline">' + escHtml(part.slice(1, -1)) + '</code>';
    return renderInlineSegment(part).replace(/\\[image attachment x(\\d+)([^\\]]*)\\]/g, '<span class="attach">image attachment x$1$2</span>');
  }).join('');
}

function renderAttachments(list) {
  if (!list || !list.length) return '';
  return '<div class="attachments">' + list.map((a, idx) => {
    const label = list.length > 1 ? 'image ' + (idx + 1) : 'image attachment';
    const media = a.mediaType ? ' · ' + a.mediaType.replace('image/', '') : '';
    return '<button class="attach" data-attachment="' + escAttr(a.id) + '" title="Open image attachment">' + label + media + '</button>';
  }).join('') + '</div>';
}

function renderSimpleMarkdown(text) {
  const normalized = String(text || '').replace(/\\r\\n/g, '\\n');
  const parts = normalized.split(/(\`\`\`[\\s\\S]*?\`\`\`)/g);
  let html = '';
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('\`\`\`')) {
      const firstLine = part.split('\\n')[0].replace(/^\`\`\`/, '').trim();
      const code = part.replace(/^\`\`\`[^\\n]*\\n?/, '').replace(/\`\`\`$/, '');
      html += '<pre><div class="code-label"><span>' + escHtml(firstLine || 'code') +
        '</span><button class="copy-code">copy</button></div><code>' + escHtml(code) + '</code></pre>';
      continue;
    }
    html += renderBlocks(part);
  }
  return html || '<p></p>';
}

function renderBlocks(text) {
  const lines = text.split('\\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^#{1,3}\\s+/.test(line)) {
      html += '<h3>' + inlineMarkdown(line.replace(/^#{1,3}\\s+/, '')) + '</h3>';
      i++;
      continue;
    }
    if (/^>\\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\\s?/, ''));
      html += '<div class="quote">' + inlineMarkdown(quote.join('\\n')) + '</div>';
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\\s*\\|?\\s*:?-{3,}:?/.test(lines[i + 1])) {
      const headers = line.split('|').map(c => c.trim()).filter(Boolean);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(lines[i].split('|').map(c => c.trim()).filter(Boolean));
        i++;
      }
      html += '<div class="table-wrap"><table><thead><tr>' + headers.map(h => '<th>' + inlineMarkdown(h) + '</th>').join('') +
        '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(c => '<td>' + inlineMarkdown(c) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>';
      continue;
    }
    if (/^\\s*[-*]\\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\\s*[-*]\\s+/.test(lines[i])) items.push(lines[i++].replace(/^\\s*[-*]\\s+/, ''));
      html += '<ul>' + items.map(item => '<li>' + inlineMarkdown(item) + '</li>').join('') + '</ul>';
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,3}\\s+/.test(lines[i]) && !/^>\\s?/.test(lines[i]) && !/^\\s*[-*]\\s+/.test(lines[i])) {
      if (lines[i].includes('|') && i + 1 < lines.length && /^\\s*\\|?\\s*:?-{3,}:?/.test(lines[i + 1])) break;
      para.push(lines[i++]);
    }
    html += '<p>' + inlineMarkdown(para.join('\\n')) + '</p>';
  }
  return html;
}

function highlightHtml(html, query, isCurrent) {
  if (!query) return html;
  const safe = query.replace(/[.*+?^${'${'}}()|[\\]\\\\]/g, '\\\\$&');
  const regex = new RegExp('(' + safe + ')', 'gi');
  let markedCurrent = false;
  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent && ['CODE', 'PRE', 'MARK'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
      regex.lastIndex = 0;
      return regex.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    regex.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let match;
    while ((match = regex.exec(node.nodeValue))) {
      frag.append(document.createTextNode(node.nodeValue.slice(last, match.index)));
      const mark = document.createElement('mark');
      if (isCurrent && !markedCurrent) mark.className = 'current';
      markedCurrent = true;
      mark.textContent = match[0];
      frag.append(mark);
      last = match.index + match[0].length;
    }
    frag.append(document.createTextNode(node.nodeValue.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
  return template.innerHTML;
}

function renderMessageBody(m, index, isCurrentMatch) {
  let text = m.text || '';
  const long = text.length > DISPLAY_CAP || text.split('\\n').length > 10;
  if (long && !expandedMessages.has(index)) text = text.slice(0, DISPLAY_CAP).trimEnd() + '...';
  let html = renderSimpleMarkdown(text);
  html = highlightHtml(html, $('search').value.trim(), isCurrentMatch);
  return { html, long };
}

function collectMatches() {
  const query = $('search').value.trim().toLowerCase();
  if (!query) return [];
  const found = [];
  DATA.messages.forEach((m, i) => {
    if (m.role === 'tool') return;
    if (filter !== 'all' && m.role !== filter) return;
    if ((m.text || '').toLowerCase().includes(query)) found.push(i);
  });
  return found;
}

function state() {
  const l = labels();
  return { filter, names: document.body.dataset.names !== 'off', userLabel: l.user, agentLabel: l.agent };
}

function render(keepScroll) {
  const chat = $('chat');
  const wasAtBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
  const prevScroll = chat.scrollTop;
  const l = labels();
  $('chipUser').textContent = l.user === 'USER' ? 'Me' : l.user;
  $('chipAgent').textContent = l.agent;
  matches = collectMatches();
  currentMatch = Math.min(currentMatch, Math.max(0, matches.length - 1));
  chat.innerHTML = '';
  const msgs = DATA.messages;
  if (!msgs.some(m => m.role !== 'tool')) {
    chat.innerHTML = '<div class="empty"><div style="font-size:26px;color:var(--agent-strong);opacity:.6">✳</div>' +
      '<div>No readable conversation in this transcript</div>' +
      '<div style="font-size:11.5px">Open raw JSON for transcript internals.</div></div>';
    return;
  }
  let start = 0;
  if (!renderAll) {
    start = Math.max(0, msgs.length - DATA.window);
    chat.insertAdjacentHTML('beforeend',
      '<div class="banner">big session — latest ' + (msgs.length - start) +
      ' rendered for speed · <b id="rall">render all ' + msgs.length + '</b> · export/copy still includes all</div>');
  }
  let lastDay = null;
  const frag = [];
  for (let i = start; i < msgs.length; i++) {
    const m = msgs[i];
    const day = dayOf(m.ts);
    if (m.role === 'tool') continue;
    if (filter !== 'all' && m.role !== filter) continue;
    if (day && day !== lastDay && filter === 'all') { frag.push('<div class="day">' + day + '</div>'); lastDay = day; }
    const who = m.role === 'user' ? l.user : l.agent;
    const body = renderMessageBody(m, i, matches[currentMatch] === i);
    const icon = m.role === 'user' ? '●' : '✳';
    const attachments = renderAttachments(m.attachments);
    const more = body.long ? '<span class="more" data-i="' + i + '">' + (expandedMessages.has(i) ? 'Show less' : 'Read more') + '</span>' : '';
    frag.push('<div class="msg ' + m.role + '" data-i="' + i + '" data-day="' + (day || '') + '"><div class="who"><span class="role-icon">' + icon + '</span>' + escHtml(who) + '</div>' + attachments + '<div class="body">' + body.html + '</div>' + more + '</div>');
  }
  frag.push('<div class="bottom-spacer" aria-hidden="true"></div>');
  chat.insertAdjacentHTML('beforeend', frag.join(''));
  const rall = $('rall');
  if (rall) rall.onclick = () => { renderAll = true; render(); };
  chat.querySelectorAll('.more').forEach(el => el.onclick = () => {
    const i = +el.dataset.i;
    if (expandedMessages.has(i)) expandedMessages.delete(i);
    else expandedMessages.add(i);
    render(true);
  });
  chat.querySelectorAll('.copy-code').forEach(btn => btn.onclick = () => {
    const code = btn.closest('pre').querySelector('code');
    if (code) navigator.clipboard.writeText(code.textContent).catch(() => {});
  });
  updateMatches(false);
  if (keepScroll && !wasAtBottom) chat.scrollTop = prevScroll;
  else chat.scrollTop = chat.scrollHeight;
  updateRail();
}

function fmtTs(ts){ if(!ts) return '?'; const d = new Date(ts);
  return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) + ' ' +
         d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }

function updateMatches(jump) {
  const query = $('search').value.trim().toLowerCase();
  if (!matches.length) {
    currentMatch = 0;
    $('count').textContent = query ? '0 / 0' : '0 / 0';
    return;
  }
  currentMatch = Math.min(currentMatch, matches.length - 1);
  $('count').textContent = (currentMatch + 1) + ' / ' + matches.length;
  const target = $('chat').querySelector('.msg[data-i="' + matches[currentMatch] + '"]');
  if (target && jump) target.scrollIntoView({ block:'center', behavior:'smooth' });
}

function currentMessage() {
  const bubbles = Array.from($('chat').querySelectorAll('.msg'));
  const target = $('chat').getBoundingClientRect().top + $('chat').clientHeight * 0.42;
  let current = bubbles[0];
  for (const bubble of bubbles) {
    if (bubble.getBoundingClientRect().top <= target) current = bubble;
    else break;
  }
  return current;
}

function updateRail() {
  const chat = $('chat');
  const max = Math.max(1, chat.scrollHeight - chat.clientHeight);
  const progress = Math.min(1, Math.max(0, chat.scrollTop / max));
  const top = (progress * 100).toFixed(2) + '%';
  $('railFill').style.setProperty('--rail-top', top);
  $('railThumb').style.setProperty('--rail-top', top);
  $('pospill').style.setProperty('--rail-top', top);
  const current = currentMessage();
  const idx = current ? Number(current.dataset.i) + 1 : 1;
  const day = current ? fmtShortDay(current.dataset.day) : '';
  $('pospill').textContent = (day ? day + ' · ' : '') + 'msg ' + idx + ' / ' + DATA.messages.length;
  $('chatwrap').classList.add('scrolling');
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => $('chatwrap').classList.remove('scrolling'), 850);
}

window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'update') {
    DATA.messages = m.messages;
    $('meta').textContent = '${esc(folder)} · ' + DATA.messages.filter(x => x.role !== 'tool').length +
      ' messages · ' + DATA.sessionId + ' · ' + fmtTs(m.firstTs) + ' → ' + fmtTs(m.lastTs) + ' · live';
    render(true);
  }
});

$('resume').onclick = () => vscodeApi.postMessage({ type:'resume' });
$('copyPath').onclick = () => vscodeApi.postMessage({ type:'copyPath' });
$('export').onclick = () => vscodeApi.postMessage(Object.assign({ type:'export' }, state()));
$('reveal').onclick = () => vscodeApi.postMessage({ type:'reveal' });
$('settingsBtn').onclick = () => $('settings').classList.toggle('open');
$('searchToggle').onclick = () => {
  $('searchbar').classList.toggle('open');
  $('searchToggle').classList.toggle('open', $('searchbar').classList.contains('open'));
  if ($('searchbar').classList.contains('open')) $('search').focus();
};
$('jump').onclick = () => { $('chat').scrollTop = $('chat').scrollHeight; updateRail(); };
$('collapseLong').onclick = () => { expandedMessages.clear(); render(true); };
$('expandLong').onclick = () => {
  DATA.messages.forEach((m, i) => { if (m.role !== 'tool' && m.text && (m.text.length > DISPLAY_CAP || m.text.split('\\n').length > 10)) expandedMessages.add(i); });
  render(true);
};
$('showNames').onchange = e => {
  document.body.dataset.names = e.target.checked ? 'on' : 'off';
  vscodeApi.postMessage({ type:'setConfig', showNames: e.target.checked });
};
$('userLabel').oninput = () => { render(true); vscodeApi.postMessage({ type:'setConfig', userLabel: $('userLabel').value }); };
$('agentLabel').oninput = () => { render(true); vscodeApi.postMessage({ type:'setConfig', agentLabel: $('agentLabel').value }); };
$('search').oninput = () => { currentMatch = 0; render(true); };
$('next').onclick = () => { if (!matches.length) return; currentMatch = (currentMatch + 1) % matches.length; render(true); updateMatches(true); };
$('prev').onclick = () => { if (!matches.length) return; currentMatch = (currentMatch - 1 + matches.length) % matches.length; render(true); updateMatches(true); };
$('clearSearch').onclick = () => {
  if ($('search').value) { $('search').value = ''; render(true); $('search').focus(); }
  else { $('searchbar').classList.remove('open'); $('searchToggle').classList.remove('open'); }
};
document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-f]').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); filter = b.dataset.f; currentMatch = 0; render(true);
});
document.querySelectorAll('[data-th]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-th]').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  document.body.className = b.dataset.th === 'system' ? 'sys' : b.dataset.th;
  vscodeApi.postMessage({ type:'setConfig', theme: b.dataset.th });
});
document.addEventListener('click', e => {
  const attachment = e.target.closest && e.target.closest('[data-attachment]');
  if (attachment) {
    e.preventDefault();
    vscodeApi.postMessage({ type:'openAttachment', id:attachment.dataset.attachment });
    return;
  }
  const link = e.target.closest && e.target.closest('a[data-href]');
  if (!link) return;
  e.preventDefault();
  vscodeApi.postMessage({ type:'openLink', href:link.dataset.href });
});
$('chat').addEventListener('scroll', updateRail, { passive:true });
window.addEventListener('resize', updateRail);
render();
</script>
</body>
</html>`;
  }
}

module.exports = { ConversationViewer };
