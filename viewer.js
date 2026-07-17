// Conversation viewer webview. Read-only by default; the only action that
// runs anything is the explicit resume-in-terminal button.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fileURLToPath } = require('url');
const { extractConversation, computeModelRuns } = require('./conversation');
const { SEARCH_SVG, MODEL_SVG } = require('./icons');

const RENDER_WINDOW = 200; // big sessions: render latest N first, "render all" banner

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
      viewerDensity: c.get('viewerDensity', 'short'),
      shortPreviewLines: c.get('shortPreviewLines', 4),
    };
  }

  open(session, title, folderLabel, opts = {}) {
    const existing = this.panels.get(session.id);
    if (existing) {
      existing.panel.reveal(opts.beside ? vscode.ViewColumn.Beside : undefined);
      if (opts.find) existing.panel.webview.postMessage({ type: 'find', ...opts.find });
      return Promise.resolve();
    }
    const inFlight = this.opening.get(session.id);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const convo = await extractConversation(session.file);
      const panel = vscode.window.createWebviewPanel(
        'claudeSessionsViewer.conversation',
        title,
        opts.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'mascot-icon.png');
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
      panel.webview.html = this.html(entry, opts.find || null);
    })();

    this.opening.set(session.id, promise);
    return promise.finally(() => this.opening.delete(session.id));
  }

  async onMessage(entry, msg) {
    const { session, convo, title, folder } = entry;
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
        if (msg.viewerDensity === 'full' || msg.viewerDensity === 'short')
          await c.update('viewerDensity', msg.viewerDensity, vscode.ConfigurationTarget.Global);
        break;
      }
    }
  }

  html(entry, find = null) {
    const { session, convo, title, folder } = entry;
    const cfg = this.config;
    const nonce = Math.random().toString(36).slice(2);
    const webview = entry.panel && entry.panel.webview;
    const mascotUri = webview && typeof webview.asWebviewUri === 'function'
      ? webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'mascot.png')).toString()
      : 'mascot.png';
    const imageSource = webview && webview.cspSource ? webview.cspSource : "'self'";
    const data = JSON.stringify({
      find,
      messages: convo.messages,
      runs: computeModelRuns(convo.messages),
      userLabel: cfg.userLabel,
      agentLabel: cfg.agentLabel,
      showNames: cfg.showNames,
      theme: cfg.theme,
      density: cfg.viewerDensity === 'full' ? 'full' : 'short',
      foldLines: Math.max(1, Math.min(30, Number(cfg.shortPreviewLines) || 4)),
      window: RENDER_WINDOW,
      sessionId: session.id,
      rawPath: session.file,
      cwd: session.cwd,
      mascotUri,
    }).replace(/</g, '\\u003c');
    const nMsgs = convo.messages.filter((m) => m.role !== 'tool').length;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imageSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html { height:100%; overflow:hidden; }
  body { --claude-spark:#d97757; margin:0;
    font-family: var(--vscode-font-family), -apple-system, 'SF Pro Text', 'Segoe UI', sans-serif;
    font-size: var(--vscode-font-size, 14px); line-height:1.48; }
  body.sys { --bg:var(--vscode-editor-background); --panel:var(--vscode-editor-background);
    --line:var(--vscode-panel-border,#3c3c3c); --fg:var(--vscode-foreground);
    --mut:var(--vscode-descriptionForeground,#8a8a8a); --chip:var(--vscode-badge-background,#333);
    --btn2:var(--vscode-button-secondaryBackground,#3a3d41); --sep:#5a5a5a;
    --user-bub:color-mix(in srgb, #e8f0f5 72%, var(--vscode-editor-background));
    --user-edge:#5b7c8f; --user-strong:#456579;
    --agent-bub:color-mix(in srgb, #ececf7 72%, var(--vscode-editor-background));
    --agent-edge:#6865a5; --agent-strong:#55518f;
    --rail-track:rgba(130,126,145,.18); --rail-fill:#8c849d; --rail-thumb:#8c849d;
    --code-bg:#282828; --code-fg:#eee; --mark:#ffe98f; }
  body.dark { --bg:#1e1e1e; --panel:#252526; --line:#3c3c3c; --fg:#ccc; --mut:#8a8a8a;
    --user-bub:#24343d; --user-edge:#7099ad; --user-strong:#93b5c6;
    --agent-bub:#29283a; --agent-edge:#8d88c5; --agent-strong:#aaa6dc;
    --chip:#333; --btn2:#3a3d41; --sep:#5a5a5a;
    --rail-track:rgba(142,134,162,.20); --rail-fill:#8f86a6; --rail-thumb:#8f86a6;
    --code-bg:#161616; --code-fg:#eee; --mark:#6f5a18; }
  body.light { --bg:#fff; --panel:#f7f7f7; --line:#dedede; --fg:#333; --mut:#767676;
    --user-bub:#e8f0f5; --user-edge:#5b7c8f; --user-strong:#456579;
    --agent-bub:#ececf7; --agent-edge:#6865a5; --agent-strong:#55518f;
    --chip:#f1f1f1; --btn2:#e9e9e9; --sep:#bbb;
    --rail-track:rgba(115,108,138,.16); --rail-fill:#8c849d; --rail-thumb:#8c849d;
    --code-bg:#282828; --code-fg:#eee; --mark:#ffe98f; }
  body { background:var(--bg); color:var(--fg); display:flex; justify-content:center; height:100%; overflow:hidden; }
  .viewer { width:min(820px,100vw); height:100%; max-height:100%; overflow:hidden; background:var(--panel); border-left:1px solid var(--line); border-right:1px solid var(--line); display:flex; flex-direction:column; position:relative; }
  .vhead { padding:10px 16px 8px; border-bottom:1px solid var(--line); background:color-mix(in srgb, var(--panel) 97%, transparent); flex-shrink:0; position:relative; z-index:8; }
  .vrow { display:flex; align-items:center; gap:10px; }
  .title { font-size:17px; font-weight:680; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ibtn { width:30px; height:30px; border:1px solid transparent; background:transparent; color:var(--mut); font-size:14px; cursor:pointer; padding:0; border-radius:7px; display:inline-flex; align-items:center; justify-content:center; }
  .ibtn:hover { background:var(--btn2); color:var(--fg); }
  .ibtn.open { background:var(--btn2); color:var(--agent-strong); }
  [data-tip] { position:relative; }
  [data-tip]::after { content:attr(data-tip); position:absolute; top:calc(100% + 6px); left:50%; transform:translateX(-50%);
    background:var(--vscode-editorHoverWidget-background,#2b2b2b); color:var(--vscode-editorHoverWidget-foreground,#fff);
    border:1px solid var(--vscode-editorHoverWidget-border,transparent); padding:3px 8px; border-radius:5px;
    font-size:11px; white-space:nowrap; opacity:0; pointer-events:none; transition:opacity .1s ease; z-index:30; }
  [data-tip]:hover::after, [data-tip]:focus-visible::after { opacity:1; transition-delay:.15s; }
  .ibtn.terminal { width:38px; border-color:var(--line); font-family:var(--vscode-editor-font-family, ui-monospace, Menlo, monospace);
    font-size:calc(var(--vscode-editor-font-size, 12px) * 0.95); line-height:1; }
  .meta { color:var(--mut); font-size:12px; margin-top:5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .controls { display:flex; gap:8px; align-items:center; padding:8px 14px; border-bottom:1px solid var(--line);
    font-size:12px; flex-wrap:nowrap; flex-shrink:0; z-index:4; position:relative; }
  .segmented { display:flex; border:1px solid var(--line); border-radius:999px; overflow:hidden; flex-shrink:0; }
  .seg { border:none; border-right:1px solid var(--line); background:transparent; color:var(--mut);
    padding:3px 10px; cursor:pointer; font:inherit; font-size:11.5px; white-space:nowrap; }
  .seg:last-child { border-right:none; }
  .seg.on { background:var(--btn2); color:var(--fg); }
  .spacer { flex:1 1 auto; }
  .searchbar { display:none; grid-template-columns:1fr auto auto auto auto; align-items:center; gap:7px;
    padding:8px 16px; border-bottom:1px solid var(--line); flex-shrink:0; z-index:4; }
  .searchbar.open { display:grid; }
  .searchbox { min-width:120px; height:28px; border:1px solid var(--line); border-radius:999px;
    padding:0 11px; background:var(--bg); color:var(--fg); font:inherit; font-size:12px; }
  .count { color:var(--mut); font-size:12px; min-width:46px; text-align:right; }
  .tiny { width:26px; height:26px; border-radius:7px; border:1px solid var(--line); background:transparent; color:var(--mut); cursor:pointer; }
  .chatwrap { position:relative; flex:1; min-height:0; }
  .chat { height:100%; overflow-y:auto; padding:16px 54px 18px 18px; scroll-behavior:smooth; scrollbar-width:none; }
  .chat::-webkit-scrollbar { width:0; height:0; }
  .banner { text-align:center; background:var(--chip); color:var(--mut); border-radius:6px; padding:5px 10px; font-size:11.5px; }
  .banner b { color:var(--fg); cursor:pointer; text-decoration:underline; }
  .day { width:max-content; margin:12px auto; position:sticky; top:8px; z-index:2; color:var(--mut); font-size:11px;
    background:var(--panel); border:1px solid var(--line); border-radius:999px; padding:2px 10px;
    box-shadow:0 2px 9px rgba(0,0,0,.05); }
  .msg { max-width:78%; width:fit-content; margin:9px 0; padding:9px 12px; border-radius:13px; overflow-wrap:break-word; position:relative; }
  .msg.folded { cursor:pointer; margin:4px 0; padding:6px 10px; }
  .msg.folded .bodywrap { display:-webkit-box; -webkit-box-orient:vertical;
    -webkit-line-clamp:var(--fold-lines, 4); overflow:hidden;
    /* line-clamp can't fracture monolithic children (code blocks are scroll
       containers), so a hard height cap guarantees the preview stays short */
    max-height:calc(var(--fold-lines, 4) * 1.52em); }
  .part-sep { height:1px; background:color-mix(in srgb, var(--line) 55%, transparent); margin:9px -3px; }
  .msg:not(.folded) .who { cursor:pointer; }
  .msg, .msg.folded { padding-right:26px; }
  .fold-ind { position:absolute; top:5px; right:7px; width:16px; height:16px; line-height:15px; text-align:center;
    color:var(--mut); opacity:.55; cursor:pointer; font-size:11px; border-radius:5px; user-select:none; }
  .fold-ind:hover { opacity:1; background:var(--btn2); color:var(--fg); }
  .msg.user { margin-left:auto; background:var(--user-bub); border-right:3px solid var(--user-edge); border-bottom-right-radius:4px; }
  .msg.assistant { margin-right:auto; background:var(--agent-bub); border-left:3px solid var(--agent-edge); border-bottom-left-radius:4px; }
  .who { font-size:11px; color:var(--mut); margin-bottom:3px; letter-spacing:.02em; font-weight:700; text-transform:uppercase; }
  .role-icon { display:inline-flex; align-items:center; justify-content:center; margin-right:4px;
    width:14px; height:14px; font-size:12px; line-height:1; vertical-align:-2px; }
  .role-icon img { display:block; width:16px; height:12px; object-fit:contain; }
  .msg.assistant .role-icon { color:var(--claude-spark); }
  .msg.user .role-icon { color:var(--user-edge); }
  body[data-names="off"] .who { display:none; }
  .body p { margin:0 0 7px; white-space:pre-wrap; }
  .body p:last-child { margin-bottom:0; }
  .body a { color:var(--vscode-textLink-foreground,#2677c9); text-decoration:underline; text-underline-offset:2px; }
  .body a:hover { color:var(--vscode-textLink-activeForeground,#1a8cff); }
  .body h3 { margin:4px 0 6px; font-size:1.1em; line-height:1.25; }
  .body ul, .body ol { margin:6px 0 6px 19px; padding:0; }
  code.inline { background:color-mix(in srgb, var(--fg) 13%, transparent); border-radius:4px; padding:1px 4px;
    font-family:var(--vscode-editor-font-family, ui-monospace, Menlo, monospace);
    font-size:calc(var(--vscode-editor-font-size, 12px) * 0.95); }
  .msg.assistant code.inline { color:var(--agent-strong); }
  .msg.user code.inline { color:var(--user-strong); }
  .quote { border-left:3px solid var(--agent-edge); background:color-mix(in srgb, var(--fg) 8%, transparent); padding:6px 8px;
    border-radius:6px; margin:7px 0; color:var(--fg); }
  .msg.user .quote { border-left-color:var(--user-edge); }
  .attachments { display:flex; flex-wrap:wrap; gap:5px; margin:0 0 6px; }
  .attach { border:1px solid var(--line); color:var(--mut); background:color-mix(in srgb, var(--fg) 9%, transparent);
    border-radius:999px; padding:2px 8px; font:inherit; font-size:11.5px; cursor:pointer; }
  .attach:hover { color:var(--fg); border-color:var(--agent-edge); }
  pre { margin:8px 0; padding:9px 10px; border-radius:8px; background:var(--code-bg); color:var(--code-fg);
    overflow-x:auto; font-family:var(--vscode-editor-font-family, ui-monospace, Menlo, monospace);
    font-size:calc(var(--vscode-editor-font-size, 12px) * 0.95); line-height:1.45; }
  .code-label { display:flex; justify-content:space-between; align-items:center; gap:8px; color:#b9b9b9; font-size:11px; margin-bottom:5px; }
  .copy-code { border:1px solid #555; border-radius:5px; background:transparent; color:#dcdcdc; font:inherit; font-size:11px; cursor:pointer; }
  .table-wrap { max-width:100%; overflow-x:auto; margin:8px 0; border:1px solid color-mix(in srgb, var(--line) 80%, var(--fg));
    border-radius:8px; background:color-mix(in srgb, var(--fg) 6%, transparent); }
  table { border-collapse:collapse; min-width:470px; width:100%; font-size:0.86em; }
  th, td { border-bottom:1px solid var(--line); padding:5px 7px; text-align:left; vertical-align:top; }
  th { background:rgba(0,0,0,.05); font-weight:700; }
  .msg.assistant th { background:color-mix(in srgb, var(--agent-edge) 12%, transparent); }
  .msg.user th { background:color-mix(in srgb, var(--user-edge) 12%, transparent); }
  mark { background:var(--mark); color:inherit; border-radius:3px; padding:0 1px; }
  mark.current { background:#ffc85a; box-shadow:0 0 0 2px rgba(217,119,87,.45); }
  .more { color:var(--agent-strong); font-size:12px; cursor:pointer; margin-top:6px; display:block; }
  .more:hover { text-decoration:underline; }
  .mstrip { position:absolute; right:29px; top:16px; bottom:72px; width:16px; border-radius:4px;
    background:var(--rail-track); display:none; flex-direction:column; overflow:hidden; z-index:5; }
  .mstrip.open { display:flex; }
  .mstrip .seg { width:100%; position:relative; display:flex; align-items:center; justify-content:center; }
  .mstrip .seg + .seg { border-top:1px solid var(--line); }
  .mstrip .seg:hover { background:var(--btn2); }
  .mstrip .seg .name { writing-mode:vertical-rl; transform:rotate(180deg); font-size:9px; font-weight:700;
    letter-spacing:.02em; color:var(--mut); white-space:nowrap; pointer-events:none; }
  .mstrip .seg.tiny .name { display:none; }
  .mstrip .seg[data-tip]::after { top:50%; left:auto; right:calc(100% + 8px); bottom:auto;
    transform:translateY(-50%); }
  .rail { position:absolute; right:6px; top:16px; bottom:72px; width:17px; border-radius:999px;
    background:transparent; cursor:grab; touch-action:none; z-index:5; }
  .rail::before { content:''; position:absolute; left:50%; transform:translateX(-50%); top:0; bottom:0;
    width:3px; border-radius:999px; background:var(--rail-track); }
  .rail.dragging { cursor:grabbing; }
  .rail-fill { position:absolute; top:0; left:50%; transform:translateX(-50%); width:3px; height:var(--rail-top,0%);
    border-radius:999px; background:var(--rail-fill); opacity:.72; pointer-events:none; }
  .rail-thumb { position:absolute; left:50%; transform:translateX(-50%); top:var(--rail-top,0%); width:9px; height:46px;
    margin-top:-23px; border-radius:999px; background:var(--rail-thumb); box-shadow:0 1px 7px rgba(0,0,0,.22);
    opacity:.82; pointer-events:none; }
  .rail:hover .rail-thumb, .rail.dragging .rail-thumb { width:11px; opacity:1; }
  .pospill { position:absolute; right:28px; top:var(--rail-top,0%); transform:translateY(-50%);
    background:rgba(55,55,55,.94); color:#fff; border-radius:999px; padding:4px 9px; font-size:11px;
    line-height:1.2; white-space:nowrap; pointer-events:none; opacity:0; transition:opacity 160ms ease; z-index:6; }
  .chatwrap.scrolling .pospill, .chatwrap:hover .pospill { opacity:1; }
  .jump { position:absolute; right:20px; bottom:16px; background:var(--panel); color:var(--mut);
    border:1px solid var(--line); border-radius:50%; width:34px; height:34px; cursor:pointer;
    display:flex; align-items:center; justify-content:center; z-index:7; }
  .bottom-spacer { height:176px; flex:0 0 auto; }
  .empty { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--mut); gap:6px; }
  .empty-mascot { width:92px; height:64px; object-fit:contain; opacity:.9; }
  @media (max-width:620px) {
    .chat { padding-right:46px; }
    .msg { max-width:86%; }
    .title { font-size:15px; }
    .controls { gap:5px; }
  }
</style>
</head>
<body class="sys" data-names="${cfg.showNames ? 'on' : 'off'}" data-density="${cfg.viewerDensity === 'full' ? 'full' : 'short'}" style="--fold-lines:${Math.max(1, Math.min(30, Number(cfg.shortPreviewLines) || 4))}">
<main class="viewer">
  <div class="vhead">
    <div class="vrow">
      <span class="title">${esc(title)}</span>
      <button class="ibtn terminal" id="resume" aria-label="Resume in Claude terminal" data-tip="Resume — runs in a terminal">▶_</button>
    </div>
    <div class="meta" id="meta">${esc(folder)} · ${nMsgs} messages · ${esc(session.id)} · ${fmt(convo.firstTs)} → ${fmt(convo.lastTs)}</div>
  </div>
  <div class="controls">
    <div class="segmented" id="filterSeg">
      <button class="seg on" data-f="all">All</button>
      <button class="seg" data-f="assistant" id="chipAgent">${esc(cfg.agentLabel)}</button>
      <button class="seg" data-f="user" id="chipUser">${esc(cfg.userLabel)}</button>
    </div>
    <div class="segmented" id="densitySeg">
      <button class="seg${cfg.viewerDensity === 'full' ? '' : ' on'}" data-d="short">Short</button>
      <button class="seg${cfg.viewerDensity === 'full' ? ' on' : ''}" data-d="full">Full</button>
    </div>
    <span class="spacer"></span>
    <button class="ibtn" id="modelToggle" aria-label="Model lane" data-tip="Which model handled what">${MODEL_SVG}</button>
    <button class="ibtn" id="searchToggle" aria-label="Search" data-tip="Search">${SEARCH_SVG}</button>
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
    <div class="mstrip" id="mstrip" aria-label="Model lane" role="img"></div>
    <div class="rail" id="rail" role="scrollbar" aria-label="Conversation position" aria-orientation="vertical"><div class="rail-fill" id="railFill"></div><div class="rail-thumb" id="railThumb"></div></div>
    <div class="pospill" id="pospill">msg 1 / ${nMsgs}</div>
    <button class="jump" id="jump" title="Jump to last message">↓</button>
  </div>
</main>

<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
const DATA = ${data};
// Folded previews are clamped by CSS; rendering huge bodies behind the clamp
// is wasted work, so cap the source text generously relative to the preview.
const FOLDED_RENDER_CAP = Math.max(1200, (DATA.foldLines || 4) * 160);
let filter = 'all';
let density = DATA.density === 'full' ? 'full' : 'short';
let renderAll = DATA.messages.length <= DATA.window * 1.2;
let currentMatch = 0;
let matches = [];
let scrollTimer = 0;
// Bubble ids whose fold state differs from the mode default
// (Short: default folded, Full: default unfolded). Cleared on mode switch.
const overrides = new Set();
const toggleFold = (i) => { if (overrides.has(i)) overrides.delete(i); else overrides.add(i); };
const isFolded = (i) => (density === 'short') !== overrides.has(i);
const $ = id => document.getElementById(id);
const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

document.body.className = DATA.theme === 'system' ? 'sys' : DATA.theme;
document.body.dataset.names = DATA.showNames ? 'on' : 'off';

function labels() {
  return {
    user: DATA.userLabel || 'USER',
    agent: DATA.agentLabel || 'CLAUDE'
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
    return part.split(/(\\*\\*[^*\\n]+\\*\\*)/g).map(seg => {
      if (seg.startsWith('**') && seg.endsWith('**') && seg.length > 4)
        return '<strong>' + renderInlineSegment(seg.slice(2, -2)) + '</strong>';
      return renderInlineSegment(seg).replace(/\\[image attachment x(\\d+)([^\\]]*)\\]/g, '<span class="attach">image attachment x$1$2</span>');
    }).join('');
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

function renderMessageBody(m, index, isCurrentMatch, folded) {
  let text = m.text || '';
  if (folded && text.length > FOLDED_RENDER_CAP) text = text.slice(0, FOLDED_RENDER_CAP);
  let html = renderSimpleMarkdown(text);
  html = highlightHtml(html, $('search').value.trim(), isCurrentMatch);
  return { html };
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

function render(keepScroll) {
  const chat = $('chat');
  const wasAtBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
  const prevScroll = chat.scrollTop;
  const l = labels();
  $('chipAgent').textContent = l.agent;
  $('chipUser').textContent = l.user;
  matches = collectMatches();
  currentMatch = Math.min(currentMatch, Math.max(0, matches.length - 1));
  chat.innerHTML = '';
  const msgs = DATA.messages;
  if (!msgs.some(m => m.role !== 'tool')) {
    chat.innerHTML = '<div class="empty"><img class="empty-mascot" src="' + escAttr(DATA.mascotUri) + '" alt="">' +
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
  // One bubble per turn: consecutive assistant messages (tool records between
  // them don't break the turn) merge into a single bubble; a user message
  // always starts a new bubble. Turn boundaries come from the ORIGINAL
  // sequence, so the speaker filter never changes how turns are grouped.
  const groups = [];
  const groupOf = {};
  for (let i = start; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'tool') continue;
    const prev = groups[groups.length - 1];
    if (prev && prev.role === 'assistant' && m.role === 'assistant') prev.indices.push(i);
    else groups.push({ role: m.role, indices: [i] });
    groupOf[i] = groups[groups.length - 1].indices[0];
  }
  // Bubbles containing search matches must be readable: force-unfold them
  // (in Short by overriding, in Full by removing a manual fold override).
  if ($('search').value.trim())
    matches.forEach(i => {
      const g = groupOf[i];
      if (g === undefined) return;
      if (density === 'short') overrides.add(g); else overrides.delete(g);
    });
  let lastDay = null;
  const frag = [];
  for (const g of groups) {
    if (filter !== 'all' && g.role !== filter) continue;
    const g0 = g.indices[0];
    const day = dayOf(msgs[g0].ts);
    if (day && day !== lastDay && filter === 'all') { frag.push('<div class="day">' + day + '</div>'); lastDay = day; }
    const who = g.role === 'user' ? l.user : l.agent;
    const icon = g.role === 'user'
      ? '●'
      : '<img src="' + escAttr(DATA.mascotUri) + '" alt="">';
    const folded = isFolded(g0);
    const parts = g.indices.map(idx => {
      const m = msgs[idx];
      const body = renderMessageBody(m, idx, matches[currentMatch] === idx, folded);
      const attachments = renderAttachments(m.attachments);
      return '<div class="part" data-i="' + idx + '">' + attachments + '<div class="body">' + body.html + '</div></div>';
    }).join('<div class="part-sep"></div>');
    const foldedClass = folded ? ' folded' : '';
    const foldInd = '<span class="fold-ind" data-fold="' + g0 + '" title="' + (folded ? 'Unfold' : 'Fold') + '">' + (folded ? '⌄' : '⌃') + '</span>';
    frag.push('<div class="msg ' + g.role + foldedClass + '" data-i="' + g0 + '" data-day="' + (day || '') + '">' + foldInd + '<div class="who"><span class="role-icon">' + icon + '</span>' + escHtml(who) + '</div><div class="bodywrap">' + parts + '</div></div>');
  }
  frag.push('<div class="bottom-spacer" aria-hidden="true"></div>');
  chat.insertAdjacentHTML('beforeend', frag.join(''));
  const rall = $('rall');
  if (rall) rall.onclick = () => { renderAll = true; render(); };
  chat.querySelectorAll('.copy-code').forEach(btn => btn.onclick = (e) => {
    e.stopPropagation();
    const code = btn.closest('pre').querySelector('code');
    if (code) navigator.clipboard.writeText(code.textContent).catch(() => {});
  });
  // Every bubble folds/unfolds individually, in both modes: the corner
  // chevron always toggles; a folded bubble also unfolds on click anywhere;
  // an unfolded bubble also folds on its name header.
  chat.querySelectorAll('.fold-ind').forEach(el => el.onclick = (e) => {
    e.stopPropagation();
    toggleFold(+el.dataset.fold);
    render(true);
  });
  chat.querySelectorAll('.msg').forEach(el => {
    const i = +el.dataset.i;
    el.onclick = (e) => {
      if (e.target.closest('a[data-href], .attach, .copy-code')) return;
      if (el.classList.contains('folded')) { toggleFold(i); render(true); }
      else if (e.target.closest('.who')) { toggleFold(i); render(true); }
    };
  });
  updateMatches(false);
  if (keepScroll && !wasAtBottom) chat.scrollTop = prevScroll;
  else chat.scrollTop = chat.scrollHeight;
  updateRail();
}

function fmtTs(ts){ if(!ts) return '?'; const d = new Date(ts);
  return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) + ' ' +
         d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }

function fmtHM(ts){ if(!ts) return '?'; return new Date(ts).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }

function modelLabel(id) {
  const m = String(id || '').match(/claude-([a-z]+)/i);
  return m ? m[1][0].toUpperCase() + m[1].slice(1) : (id || 'Unknown');
}

// Which model handled which stretch of the conversation: a thin neutral
// strip, divider lines only (no per-model color — a flat list of chips
// already does that job better). Whole-session and static: computed once
// server-side (DATA.runs), independent of scroll/filter/window state.
function renderModelStrip() {
  const strip = $('mstrip');
  const runs = DATA.runs || [];
  const total = runs.reduce((s, r) => s + r.turns, 0) || 1;
  strip.innerHTML = runs.map(r => {
    const label = modelLabel(r.model);
    const range = r.tsStart === r.tsEnd ? fmtHM(r.tsStart) : fmtHM(r.tsStart) + '–' + fmtHM(r.tsEnd);
    const tip = label + ' · ' + r.turns + ' turn' + (r.turns === 1 ? '' : 's') + ' · ' + range;
    const pct = Math.max(1.5, (r.turns / total) * 100);
    const tiny = pct < 8 ? ' tiny' : '';
    return '<div class="seg' + tiny + '" style="height:' + pct + '%" data-tip="' + escAttr(tip) + '">' +
      '<span class="name">' + escHtml(label) + '</span></div>';
  }).join('');
}

function updateMatches(jump) {
  const query = $('search').value.trim().toLowerCase();
  if (!matches.length) {
    currentMatch = 0;
    $('count').textContent = query ? '0 / 0' : '0 / 0';
    return;
  }
  currentMatch = Math.min(currentMatch, matches.length - 1);
  $('count').textContent = (currentMatch + 1) + ' / ' + matches.length;
  const target = $('chat').querySelector('.part[data-i="' + matches[currentMatch] + '"]') ||
    $('chat').querySelector('.msg[data-i="' + matches[currentMatch] + '"]');
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

// Global-search deep link: open the in-session search bar with the phrase
// and land on the match closest to the target message timestamp. Reuses the
// existing matches/highlight machinery; renderAll is forced because the
// target may sit outside the latest-200 window.
function applyFind(f) {
  if (!f || !f.query) return;
  renderAll = true;
  filter = 'all';
  document.querySelectorAll('[data-f]').forEach(x => x.classList.toggle('on', x.dataset.f === 'all'));
  $('searchbar').classList.add('open');
  $('searchToggle').classList.add('open');
  $('search').value = f.query;
  currentMatch = 0;
  render(true);
  if (f.ts && matches.length) {
    const t = Date.parse(f.ts) || 0;
    let best = 0, bestD = Infinity;
    matches.forEach((mi, k) => {
      const d = Math.abs((Date.parse(DATA.messages[mi].ts || 0) || 0) - t);
      if (d < bestD) { bestD = d; best = k; }
    });
    currentMatch = best;
    render(true);
  }
  updateMatches(true);
}

window.addEventListener('message', e => {
  const m = e.data;
  if (m.type === 'find') { applyFind(m); return; }
  if (m.type === 'update') {
    DATA.messages = m.messages;
    $('meta').textContent = '${esc(folder)} · ' + DATA.messages.filter(x => x.role !== 'tool').length +
      ' messages · ' + DATA.sessionId + ' · ' + fmtTs(m.firstTs) + ' → ' + fmtTs(m.lastTs) + ' · live';
    render(true);
  }
});

$('resume').onclick = () => vscodeApi.postMessage({ type:'resume' });
$('searchToggle').onclick = () => {
  $('searchbar').classList.toggle('open');
  $('searchToggle').classList.toggle('open', $('searchbar').classList.contains('open'));
  if ($('searchbar').classList.contains('open')) $('search').focus();
};
$('modelToggle').onclick = () => {
  $('mstrip').classList.toggle('open');
  $('modelToggle').classList.toggle('open', $('mstrip').classList.contains('open'));
};
renderModelStrip();
$('jump').onclick = () => { $('chat').scrollTop = $('chat').scrollHeight; updateRail(); };
$('search').oninput = () => {
  currentMatch = 0;
  if (!$('search').value.trim()) overrides.clear();
  render(true);
};
$('next').onclick = () => { if (!matches.length) return; currentMatch = (currentMatch + 1) % matches.length; render(true); updateMatches(true); };
$('prev').onclick = () => { if (!matches.length) return; currentMatch = (currentMatch - 1 + matches.length) % matches.length; render(true); updateMatches(true); };
$('clearSearch').onclick = () => {
  if ($('search').value) {
    $('search').value = '';
    overrides.clear();
    render(true);
    $('search').focus();
  } else {
    $('searchbar').classList.remove('open');
    $('searchToggle').classList.remove('open');
  }
};
document.querySelectorAll('[data-d]').forEach(b => b.onclick = () => {
  if (b.dataset.d === density) return;
  document.querySelectorAll('[data-d]').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  density = b.dataset.d;
  document.body.dataset.density = density;
  overrides.clear();
  vscodeApi.postMessage({ type:'setConfig', viewerDensity: density });
  render(true);
});
document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-f]').forEach(x => x.classList.remove('on'));
  b.classList.add('on'); filter = b.dataset.f; currentMatch = 0; render(true);
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
(() => {
  const rail = $('rail');
  const chat = $('chat');
  let dragging = false;
  const scrollTo = (clientY) => {
    const r = rail.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientY - r.top) / Math.max(1, r.height)));
    chat.scrollTop = ratio * (chat.scrollHeight - chat.clientHeight);
  };
  rail.addEventListener('pointerdown', (e) => {
    dragging = true;
    rail.classList.add('dragging');
    rail.setPointerCapture(e.pointerId);
    chat.style.scrollBehavior = 'auto';
    scrollTo(e.clientY);
    e.preventDefault();
  });
  rail.addEventListener('pointermove', (e) => { if (dragging) scrollTo(e.clientY); });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    rail.classList.remove('dragging');
    if (e.pointerId !== undefined && rail.hasPointerCapture(e.pointerId)) rail.releasePointerCapture(e.pointerId);
    chat.style.scrollBehavior = '';
  };
  rail.addEventListener('pointerup', stop);
  rail.addEventListener('pointercancel', stop);
})();
render();
if (DATA.find) applyFind(DATA.find);
</script>
</body>
</html>`;
  }
}

module.exports = { ConversationViewer };
