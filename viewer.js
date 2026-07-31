// Conversation viewer webview. Read-only by default; the only action that
// runs anything is the explicit resume-in-terminal button.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fileURLToPath } = require('url');
const { extractConversation, conversationToText } = require('./conversation');
const { extractCodexConversation } = require('./codex-indexer');
const { SEARCH_SVG, MODEL_SVG, COPY_SVG, REFRESH_SVG } = require('./icons');

const RENDER_WINDOW = 200; // big sessions: render latest N first, "render all" banner
const OUTPUT_EXTENSIONS = new Map([
  ['html', 'HTML'], ['htm', 'HTML'], ['pdf', 'PDF'], ['csv', 'CSV'],
  ['xlsx', 'SHEET'], ['xls', 'SHEET'], ['docx', 'DOC'], ['pptx', 'SLIDES'],
  ['png', 'IMAGE'], ['jpg', 'IMAGE'], ['jpeg', 'IMAGE'], ['webp', 'IMAGE'],
  ['gif', 'IMAGE'], ['svg', 'IMAGE'], ['md', 'MARKDOWN'], ['txt', 'TEXT'],
  ['json', 'JSON'], ['jsonl', 'JSONL'],
]);
const BARE_OUTPUT_EXTENSIONS = new Set([
  'html', 'htm', 'pdf', 'csv', 'xlsx', 'xls', 'docx', 'pptx',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg',
]);

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cleanLabel(value, fallback) {
  const label = String(value == null ? '' : value).trim().slice(0, 40);
  return label || fallback;
}

function outputKind(href) {
  const value = String(href || '').trim();
  const lower = value.toLowerCase();
  if (/^https?:\/\/docs\.google\.com\/spreadsheets(?:\/|$)/.test(lower)) return 'SHEET';
  if (/^https?:\/\/docs\.google\.com\/document(?:\/|$)/.test(lower)) return 'DOC';
  if (/^https?:\/\/docs\.google\.com\/presentation(?:\/|$)/.test(lower)) return 'SLIDES';
  const clean = lower.split(/[?#]/, 1)[0];
  const match = clean.match(/\.([a-z0-9]+)$/);
  return match ? OUTPUT_EXTENSIONS.get(match[1]) || null : null;
}

function outputTitle(label, href, kind) {
  const cleanLabelValue = String(label || '').replace(/\s+/g, ' ').trim();
  if (cleanLabelValue && cleanLabelValue !== href && !/^(open|here|link|file)$/i.test(cleanLabelValue)) {
    return cleanLabelValue.slice(0, 100);
  }
  if (kind === 'SHEET' && /^https?:\/\/docs\.google\.com/i.test(href)) return 'Google Sheets';
  if (kind === 'DOC' && /^https?:\/\/docs\.google\.com/i.test(href)) return 'Google Docs';
  if (kind === 'SLIDES' && /^https?:\/\/docs\.google\.com/i.test(href)) return 'Google Slides';
  const clean = String(href || '').split(/[?#]/, 1)[0].replace(/\/$/, '');
  const name = clean.split('/').pop();
  try { return decodeURIComponent(name || href).slice(0, 100); } catch { return (name || href).slice(0, 100); }
}

function extractMessageOutputs(text) {
  const source = String(text || '');
  const outputs = [];
  const seen = new Set();
  const add = (label, rawHref) => {
    const href = String(rawHref || '').trim().replace(/[.,;:!?]+$/, '');
    const kind = outputKind(href);
    if (!href || !kind || seen.has(href)) return;
    seen.add(href);
    outputs.push({ kind, title: outputTitle(label, href, kind), href });
  };

  let scrubbed = source.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (whole, label, href) => {
    add(label, href);
    return ' '.repeat(whole.length);
  });
  scrubbed = scrubbed.replace(/(?:https?:\/\/|file:\/\/)[^\s<>"'`\])]+/g, (href) => {
    add('', href);
    return ' '.repeat(href.length);
  });

  const barePattern = /(?:^|[\s(])((?:~\/|\/|\.\.?\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.([A-Za-z0-9]+))(?=$|[\s),.;:])/g;
  let match;
  while ((match = barePattern.exec(scrubbed))) {
    const ext = String(match[2] || '').toLowerCase();
    if (BARE_OUTPUT_EXTENSIONS.has(ext)) add('', match[1]);
  }
  return outputs.slice(0, 8);
}

function outputsForMessages(messages) {
  return (messages || []).map((message) =>
    message && message.role === 'assistant' ? extractMessageOutputs(message.text) : []
  );
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
      userLabel: cleanLabel(c.get('userLabel', 'USER'), 'USER'),
      agentLabel: cleanLabel(c.get('agentLabel', 'CLAUDE'), 'CLAUDE'),
      liveRefresh: c.get('liveRefresh.enabled', false),
      shortPreviewLines: c.get('shortPreviewLines', 14),
    };
  }

  extract(session) {
    return session && session.source === 'codex'
      ? extractCodexConversation(session.file)
      : extractConversation(session.file);
  }

  open(session, title, folderLabel, opts = {}) {
    const panelKey = `${session.source || 'claude'}:${session.id}`;
    const existing = this.panels.get(panelKey);
    if (existing) {
      existing.panel.reveal(opts.beside ? vscode.ViewColumn.Beside : undefined);
      if (opts.find) existing.panel.webview.postMessage({ type: 'find', ...opts.find });
      return Promise.resolve();
    }
    const inFlight = this.opening.get(panelKey);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const convo = await this.extract(session);
      const panel = vscode.window.createWebviewPanel(
        'claudeSessionsViewer.conversation',
        title,
        opts.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      panel.iconPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'assets',
        session.source === 'codex' ? 'codex-logo.svg' : 'icon.svg'
      );
      const entry = { panel, convo, session, title, folder: folderLabel };
      this.panels.set(panelKey, entry);

      const fsMod = require('fs');
      let listener = null;
      if (this.config.liveRefresh) {
        let refreshing = false;
        listener = async () => {
          if (refreshing) return;
          refreshing = true;
          try {
            entry.convo = await this.extract(session);
            panel.webview.postMessage({
              type: 'update',
              messages: entry.convo.messages,
              firstTs: entry.convo.firstTs,
              lastTs: entry.convo.lastTs,
              outputs: outputsForMessages(entry.convo.messages),
            });
          } catch {}
          refreshing = false;
        };
        fsMod.watchFile(session.file, { interval: 3000 }, listener);
      }

      panel.onDidDispose(() => {
        if (listener) fsMod.unwatchFile(session.file, listener);
        this.panels.delete(panelKey);
      });
      panel.webview.onDidReceiveMessage((msg) => this.onMessage(entry, msg));
      panel.webview.html = this.html(entry, opts.find || null);
    })();

    this.opening.set(panelKey, promise);
    return promise.finally(() => this.opening.delete(panelKey));
  }

  async onMessage(entry, msg) {
    const { session, convo, title, folder } = entry;
    const cfg = this.config;
    switch (msg.type) {
      case 'refresh': {
        try {
          entry.convo = await this.extract(session);
          entry.panel.webview.postMessage({
            type: 'update',
            messages: entry.convo.messages,
            firstTs: entry.convo.firstTs,
            lastTs: entry.convo.lastTs,
            outputs: outputsForMessages(entry.convo.messages),
          });
        } catch (error) {
          vscode.window.showErrorMessage(`Claude Sessions: could not refresh conversation — ${error.message}`);
          entry.panel.webview.postMessage({ type: 'refreshError' });
        }
        break;
      }
      case 'revealInTree':
        await vscode.commands.executeCommand('claudeSessions.revealViewerSession', session.id);
        break;
      case 'openClaudeCode':
        await vscode.commands.executeCommand('claudeSessions.openViewerInClaudeCode', session);
        break;
      case 'resume': {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.id)) {
          vscode.window.showErrorMessage('Claude Sessions: refusing to resume — session id is not a valid UUID.');
          break;
        }
        const provider = session.source === 'codex' ? 'codex' : 'claude';
        const terminal = vscode.window.createTerminal({ name: `${provider} · ${folder}`, cwd: session.cwd });
        terminal.show();
        terminal.sendText(provider === 'codex' ? `codex resume ${session.id}` : `claude --resume ${session.id}`, true);
        break;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(conversationToText(convo, {
          title,
          folder,
          userLabel: cfg.userLabel,
          agentLabel: session.source === 'codex' ? 'CODEX' : cfg.agentLabel,
          names: true,
          filter: 'all',
          withTools: false,
        }));
        vscode.window.showInformationMessage(
          `Copied entire conversation (${convo.messages.filter((m) => m.role !== 'tool').length} messages)`
        );
        break;
      case 'copyMessage': {
        const indices = Array.isArray(msg.indices)
          ? msg.indices.filter((i) => Number.isInteger(i) && i >= 0 && i < convo.messages.length)
          : [];
        const text = indices
          .map((i) => convo.messages[i])
          .filter((m) => m && m.role !== 'tool' && m.text)
          .map((m) => m.text)
          .join('\n\n');
        if (text) await vscode.env.clipboard.writeText(text);
        break;
      }
      case 'copyOutput': {
        const value = String(msg.value || '').trim().slice(0, 20000);
        if (value) await vscode.env.clipboard.writeText(value);
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
    }
  }

  html(entry, find = null) {
    const { session, convo, title, folder } = entry;
    const cfg = this.config;
    if (session.source === 'codex') cfg.agentLabel = 'CODEX';
    const officialLabel = session.source === 'codex' ? 'Codex' : 'Claude Code';
    const nonce = Math.random().toString(36).slice(2);
    const webview = entry.panel && entry.panel.webview;
    const mascotAsset = session.source === 'codex' ? 'codex-logo.svg' : 'mascot.png';
    const mascotUri = webview && typeof webview.asWebviewUri === 'function'
      ? webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'assets', mascotAsset)).toString()
      : mascotAsset;
    const folderIconUri = webview && typeof webview.asWebviewUri === 'function'
      ? webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'folder-neutral-light.svg')).toString()
      : 'folder-neutral-light.svg';
    const revealIconUri = webview && typeof webview.asWebviewUri === 'function'
      ? webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'tree-open-preview-light.svg')).toString()
      : 'tree-open-preview-light.svg';
    const terminalIconUri = webview && typeof webview.asWebviewUri === 'function'
      ? webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'tree-terminal-light.svg')).toString()
      : 'tree-terminal-light.svg';
    const officialIconAsset = session.source === 'codex' ? 'codex-logo.svg' : 'claude-code-logo-light.svg';
    const claudeIconUri = webview && typeof webview.asWebviewUri === 'function'
      ? webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'assets', officialIconAsset)).toString()
      : officialIconAsset;
    const imageSource = webview && webview.cspSource ? webview.cspSource : "'self'";
    const data = JSON.stringify({
      find,
      messages: convo.messages,
      outputs: outputsForMessages(convo.messages),
      userLabel: cfg.userLabel,
      agentLabel: cfg.agentLabel,
      theme: cfg.theme,
      foldLines: Math.max(1, Math.min(30, Number(cfg.shortPreviewLines) || 14)),
      window: RENDER_WINDOW,
      sessionId: session.id,
      rawPath: session.file,
      cwd: session.cwd,
      source: session.source || 'claude',
      mascotUri,
      folderIconUri,
      claudeIconUri,
    }).replace(/</g, '\\u003c');
    const messageCopyIcon = JSON.stringify(COPY_SVG).replace(/</g, '\\u003c');
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
    --user-bub:color-mix(in srgb, #5b7c8f 9%, var(--vscode-editor-background));
    --user-edge:#5b7c8f; --user-strong:#456579;
    --agent-bub:color-mix(in srgb, #d97757 5%, var(--vscode-editor-background));
    --agent-edge:#c66b4b; --agent-strong:#a95438;
    --rail-track:rgba(130,126,145,.18); --rail-fill:#8c849d; --rail-thumb:#8c849d;
    --code-bg:#282828; --code-fg:#eee; --mark:#ffe98f; }
  body.dark { --bg:#1e1e1e; --panel:#252526; --line:#3c3c3c; --fg:#ccc; --mut:#8a8a8a;
    --user-bub:color-mix(in srgb, #7099ad 13%, #1e1e1e); --user-edge:#7099ad; --user-strong:#93b5c6;
    --agent-bub:color-mix(in srgb, #d97757 8%, #1e1e1e); --agent-edge:#d97757; --agent-strong:#e39a80;
    --chip:#333; --btn2:#3a3d41; --sep:#5a5a5a;
    --rail-track:rgba(142,134,162,.20); --rail-fill:#8f86a6; --rail-thumb:#8f86a6;
    --code-bg:#161616; --code-fg:#eee; --mark:#6f5a18; }
  body.light { --bg:#fff; --panel:#f7f7f7; --line:#dedede; --fg:#333; --mut:#767676;
    --user-bub:color-mix(in srgb, #5b7c8f 9%, #fff); --user-edge:#5b7c8f; --user-strong:#456579;
    --agent-bub:color-mix(in srgb, #d97757 6%, #fff); --agent-edge:#c66b4b; --agent-strong:#a95438;
    --chip:#f1f1f1; --btn2:#e9e9e9; --sep:#bbb;
    --rail-track:rgba(115,108,138,.16); --rail-fill:#8c849d; --rail-thumb:#8c849d;
    --code-bg:#282828; --code-fg:#eee; --mark:#ffe98f; }
  body { background:var(--bg); color:var(--fg); display:flex; justify-content:center; height:100%; overflow:hidden; }
  .viewer { width:min(820px,100vw); height:100%; max-height:100%; overflow:hidden; background:var(--panel); border-left:1px solid var(--line); border-right:1px solid var(--line); display:flex; flex-direction:column; position:relative; }
  .vhead { padding:8px 16px 7px; border-bottom:1px solid var(--line); background:color-mix(in srgb, var(--panel) 97%, transparent); flex-shrink:0; position:relative; z-index:8; }
  .vrow { display:flex; align-items:center; min-width:0; }
  .title { font-size:14px; font-weight:600; flex:1 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .folder-row { display:flex; align-items:center; min-width:0; margin-bottom:3px; }
  .header-actions { display:flex; align-items:center; gap:0; flex:0 0 auto; padding:1px; }
  .header-btn { width:22px; height:22px; border:1px solid transparent; background:transparent; color:var(--mut); cursor:pointer; padding:0; border-radius:3px; display:inline-flex; align-items:center; justify-content:center; }
  .header-btn:hover, .header-btn:focus-visible { background:var(--btn2); color:var(--fg); outline:none; }
  .header-btn img { width:16px; height:16px; object-fit:contain; }
  .ibtn { width:30px; height:30px; border:1px solid transparent; background:transparent; color:var(--mut); font-size:14px; cursor:pointer; padding:0; border-radius:7px; display:inline-flex; align-items:center; justify-content:center; }
  .ibtn:hover { background:var(--btn2); color:var(--fg); }
  .ibtn.open { background:var(--btn2); color:var(--agent-strong); }
  [data-tip] { position:relative; }
  [data-tip]::after { content:attr(data-tip); position:absolute; top:calc(100% + 6px); left:50%; transform:translateX(-50%);
    background:var(--vscode-editorHoverWidget-background,#2b2b2b); color:var(--vscode-editorHoverWidget-foreground,#fff);
    border:1px solid var(--vscode-editorHoverWidget-border,transparent); padding:3px 8px; border-radius:5px;
    font-size:11px; white-space:nowrap; opacity:0; pointer-events:none; transition:opacity .1s ease; z-index:30; }
  [data-tip]:hover::after, [data-tip]:focus-visible::after { opacity:1; transition-delay:.15s; }
  .folder-label { display:flex; align-items:center; gap:5px; flex:1 1 auto; min-width:0; color:var(--mut); font-size:11px; line-height:1.2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .folder-label img { width:13px; height:13px; flex:0 0 13px; object-fit:contain; opacity:.9; }
  .folder-label span { overflow:hidden; text-overflow:ellipsis; }
  .controls { display:flex; gap:8px; align-items:center; padding:8px 14px; border-bottom:1px solid var(--line);
    font-size:12px; flex-wrap:nowrap; flex-shrink:0; z-index:4; position:relative; }
  .segmented { display:flex; border:1px solid var(--line); border-radius:999px; overflow:hidden; flex-shrink:0; }
  .seg { border:none; border-right:1px solid var(--line); background:transparent; color:var(--mut);
    padding:3px 10px; cursor:pointer; font:inherit; font-size:11.5px; white-space:nowrap; }
  .seg:last-child { border-right:none; }
  .seg.on { background:var(--btn2); color:var(--fg); }
  .scale-btn { width:24px; height:24px; border:1px solid var(--line); border-radius:6px; background:transparent;
    color:var(--mut); cursor:pointer; padding:0; font:inherit; font-size:15px; line-height:1; }
  .scale-btn:hover, .scale-btn:focus-visible { background:var(--btn2); color:var(--fg); outline:none; }
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
  .msg { width:fit-content; margin:9px 0; padding:9px 12px; border-radius:13px; overflow-wrap:break-word; position:relative; }
  .msg.folded { cursor:pointer; margin:4px 0; padding:6px 10px; }
  .msg.folded .bodywrap { overflow:hidden; max-height:calc(var(--message-fold-lines, 14) * 1.55em);
    -webkit-mask-image:linear-gradient(to bottom, #000 0%, #000 calc(100% - 3rem), transparent 100%);
    mask-image:linear-gradient(to bottom, #000 0%, #000 calc(100% - 3rem), transparent 100%); }
  .part-sep { height:1px; background:color-mix(in srgb, var(--line) 55%, transparent); margin:9px -3px; }
  .msg, .msg.folded { padding-right:26px; }
  .msg.user { max-width:82%; margin-left:auto; background:var(--user-bub); border-bottom-right-radius:4px; }
  .msg.assistant { max-width:96%; margin-right:auto; background:var(--agent-bub); border-bottom-left-radius:4px; }
  .msg.filter-hidden, .day.filter-hidden { display:none; }
  .msg-copy { position:absolute; bottom:-8px; width:22px; height:22px; padding:0; display:flex; align-items:center; justify-content:center;
    border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--mut); cursor:pointer;
    opacity:0; pointer-events:none; transform:translateY(2px); transition:opacity .1s ease, transform .1s ease, color .1s ease; z-index:3; }
  .msg.assistant .msg-copy { left:6px; }
  .msg.user .msg-copy { right:6px; }
  .msg:hover .msg-copy, .msg:focus-within .msg-copy { opacity:.78; pointer-events:auto; transform:translateY(0); }
  .msg-copy:hover, .msg-copy:focus-visible, .msg-copy.copied { opacity:1; color:var(--fg); background:var(--btn2); outline:none; }
  .msg-copy svg { width:13px; height:13px; }
  .msg-copy .copied-mark { font-size:14px; line-height:1; }
  .message-footer { display:flex; align-items:center; gap:6px; margin-top:7px; color:var(--mut);
    font-size:10.5px; letter-spacing:.01em; min-height:18px;
    visibility:hidden; opacity:0; transition:opacity .12s ease; }
  body.footer-visible .message-footer { visibility:visible; opacity:1; }
  .message-footer-avatar { width:15px; height:15px; flex:0 0 15px; object-fit:contain; }
  body.dark .message-footer-avatar { filter:invert(1) opacity(.84); }
  .message-footer-user { color:var(--user-strong); font-size:10px; font-weight:700; }
  .more { border:0; padding:0; margin:7px 0 0; background:transparent; color:var(--mut);
    font:inherit; font-size:12px; cursor:pointer; display:block; }
  .more:hover, .more:focus-visible { color:var(--fg); text-decoration:underline; outline:none; }
  .more::after { content:'⌄'; display:inline-block; margin-left:5px; font-size:12px; }
  .msg:not(.folded) .more::after { content:'⌃'; }
  .more[hidden] { display:none; }
  .ibtn.spinning svg { animation:spin .8s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .body { font-size:calc(15px * var(--reader-scale, 1)); line-height:1.55; }
  .body p { margin:0 0 8px; white-space:pre-wrap; }
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
    font-size:calc(var(--vscode-editor-font-size, 12px) * 0.95 * var(--reader-scale, 1)); line-height:1.45; }
  .code-label { display:flex; justify-content:space-between; align-items:center; gap:8px; color:#b9b9b9; font-size:11px; margin-bottom:5px; }
  .copy-code { border:1px solid #555; border-radius:5px; background:transparent; color:#dcdcdc; font:inherit; font-size:11px; cursor:pointer; }
  .table-wrap { max-width:100%; overflow-x:auto; margin:8px 0; border:1px solid color-mix(in srgb, var(--line) 80%, var(--fg));
    border-radius:8px; background:color-mix(in srgb, var(--fg) 6%, transparent); }
  table { border-collapse:collapse; min-width:470px; width:100%; font-size:0.86em; }
  th, td { border-bottom:1px solid var(--line); padding:5px 7px; text-align:left; vertical-align:top; }
  th { background:rgba(0,0,0,.05); font-weight:700; }
  .msg.assistant th { background:color-mix(in srgb, var(--agent-edge) 12%, transparent); }
  .msg.user th { background:color-mix(in srgb, var(--user-edge) 12%, transparent); }
  .outputs { margin:11px 0 1px; padding-left:10px; border-left:2px solid color-mix(in srgb, var(--claude-spark) 78%, var(--line)); }
  .outputs-head { display:flex; align-items:center; gap:7px; padding:0 0 4px; border-bottom:1px solid var(--line);
    color:var(--claude-spark); font-size:10px; font-weight:700; text-transform:uppercase; }
  .outputs-count { color:var(--mut); font-weight:400; text-transform:none; }
  .output-row { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:8px;
    min-width:0; padding:7px 0; border-bottom:1px solid color-mix(in srgb, var(--line) 72%, transparent); }
  .output-chip, .output-copy { border:0; background:transparent; cursor:pointer; font:inherit; }
  .output-chip { min-width:42px; padding:2px 6px; border:1px solid currentColor; border-radius:5px;
    color:var(--vscode-textLink-foreground,#2677c9); font-size:10.5px; font-weight:700; letter-spacing:.02em; }
  .output-chip[data-kind="SHEET"] { color:var(--vscode-testing-iconPassed,#18864b); }
  .output-chip[data-kind="DOC"], .output-chip[data-kind="SLIDES"] { color:var(--agent-strong); }
  .output-chip:hover, .output-chip:focus-visible { background:color-mix(in srgb, currentColor 10%, transparent); outline:none; }
  .output-main { min-width:0; }
  .output-title { color:var(--fg); font-size:12px; font-weight:600; line-height:1.3; overflow-wrap:anywhere; white-space:normal; }
  .output-copy { width:24px; height:24px; padding:0; display:flex; align-items:center; justify-content:center;
    color:var(--mut); border-radius:5px; white-space:nowrap; }
  .output-copy svg { width:13px; height:13px; }
  .output-copy:hover, .output-copy:focus-visible { color:var(--fg); background:var(--btn2); outline:none; }
  .output-copy .copied-mark { font-size:14px; line-height:1; }
  mark { background:var(--mark); color:inherit; border-radius:3px; padding:0 1px; }
  mark.current { background:#ffc85a; box-shadow:0 0 0 2px rgba(217,119,87,.45); }
  .rail { position:absolute; right:6px; top:16px; bottom:72px; width:17px; border-radius:999px;
    background:transparent; cursor:grab; touch-action:none; z-index:5; }
  .rail::before { content:''; position:absolute; left:50%; transform:translateX(-50%); top:0; bottom:0;
    width:3px; border-radius:999px; background:var(--rail-track); }
  .rail.dragging { cursor:grabbing; }
  .rail-fill { position:absolute; top:0; left:50%; transform:translateX(-50%); width:3px; height:var(--rail-top,0%);
    border-radius:999px; background:var(--rail-fill); opacity:.72; pointer-events:none; }
  .rail-thumb { position:absolute; left:50%; transform:translateX(-50%); top:var(--rail-top,0%); width:9px; height:46px;
    margin-top:-23px; border-radius:999px; background:var(--rail-thumb); box-shadow:0 1px 7px rgba(0,0,0,.22);
    opacity:0; pointer-events:none; transition:opacity 160ms ease; }
  .chatwrap:hover .rail-thumb, .chatwrap.scrolling .rail-thumb { opacity:.82; }
  .rail:hover .rail-thumb, .rail.dragging .rail-thumb { width:11px; opacity:1; }
  .pospill { position:absolute; right:28px; top:clamp(26px, var(--rail-top,0%), calc(100% - 88px)); transform:translateY(-50%);
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
    .chat { padding:14px 38px 18px 12px; }
    .msg.user { max-width:88%; }
    .msg.assistant { max-width:100%; }
    .title { font-size:15px; }
    .controls { gap:5px; }
  }
  @media (max-width:360px) {
    .chat { padding-left:9px; padding-right:30px; }
    .msg { padding-left:9px; padding-right:22px; }
    .output-row { grid-template-columns:auto minmax(0,1fr); gap:5px 7px; }
    .output-title { white-space:normal; overflow-wrap:anywhere; }
    .rail { right:1px; }
    .jump { right:7px; }
  }
</style>
</head>
<body class="sys footer-hidden" style="--fold-lines:${Math.max(1, Math.min(30, Number(cfg.shortPreviewLines) || 14))}">
<main class="viewer">
  <div class="vhead">
    <div class="folder-row">
      <div class="folder-label" title="${escAttr(folder)}"><img src="${escAttr(folderIconUri)}" alt=""><span>${esc(folder)}</span></div>
      <div class="header-actions" aria-label="Session actions">
        <button class="header-btn" id="revealInTree" aria-label="Reveal this session in the tree" data-tip="Reveal in tree"><img src="${escAttr(revealIconUri)}" alt=""></button>
        <button class="header-btn" id="openClaudeCode" aria-label="Open this session in ${escAttr(officialLabel)}" data-tip="Open in ${escAttr(officialLabel)}"><img src="${escAttr(claudeIconUri)}" alt=""></button>
        <button class="header-btn" id="resumeTerminal" aria-label="Resume this session in a terminal" data-tip="Resume in terminal"><img src="${escAttr(terminalIconUri)}" alt=""></button>
        <button class="header-btn" id="refreshViewer" aria-label="Refresh conversation" data-tip="Refresh conversation">${REFRESH_SVG}</button>
      </div>
    </div>
    <div class="vrow">
      <span class="title" title="${escAttr(title)}">${esc(title)}</span>
    </div>
  </div>
  <div class="controls">
    <div class="segmented" id="filterSeg">
      <button class="seg on" data-f="all">All</button>
      <button class="seg" data-f="assistant" id="chipAgent">${esc(cfg.agentLabel)}</button>
      <button class="seg" data-f="user" id="chipUser">${esc(cfg.userLabel)}</button>
    </div>
    <span class="spacer"></span>
    <button class="scale-btn" id="fontDown" aria-label="Decrease conversation text size" data-tip="Decrease text size">−</button>
    <button class="scale-btn" id="fontUp" aria-label="Increase conversation text size" data-tip="Increase text size">+</button>
    <button class="ibtn" id="modelToggle" aria-label="Show message details" aria-pressed="false" data-tip="Show model and speaker">${MODEL_SVG}</button>
    <button class="ibtn" id="copyConversation" aria-label="Copy whole conversation" data-tip="Copy whole conversation">${COPY_SVG}</button>
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
    <div class="rail" id="rail" role="scrollbar" aria-label="Conversation position" aria-orientation="vertical"><div class="rail-fill" id="railFill"></div><div class="rail-thumb" id="railThumb"></div></div>
    <div class="pospill" id="pospill">msg 1 / ${nMsgs}</div>
    <button class="jump" id="jump" title="Jump to last message">↓</button>
  </div>
</main>

<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
const DATA = ${data};
const MESSAGE_COPY_ICON = ${messageCopyIcon};
let filter = 'all';
let renderAll = DATA.messages.length <= DATA.window * 1.2;
let currentMatch = 0;
let matches = [];
let scrollTimer = 0;
// Bubble ids expanded by the reader. Long messages start compact and expose
// their own Show more / Show less control.
const overrides = new Set();
const filterAnchors = new Map();
const savedViewerState = vscodeApi.getState() || {};
let readerScale = Math.min(1.25, Math.max(0.85, Number(savedViewerState.readerScale) || 1));
const $ = id => document.getElementById(id);
const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

document.body.className = (DATA.theme === 'system' ? 'sys' : DATA.theme) + ' footer-hidden';
document.body.style.setProperty('--reader-scale', readerScale);

function labels() {
  return {
    user: DATA.userLabel || 'USER',
    agent: DATA.agentLabel || 'CLAUDE'
  };
}

function foldLinesForRole(role) {
  const base = Math.max(1, Number(DATA.foldLines) || 14);
  return role === 'user' ? 4 : base;
}

function messageFooter(m) {
  const isUser = m.role === 'user';
  const label = isUser
    ? (DATA.userLabel || 'USER')
    : (DATA.agentLabel || 'CLAUDE') + (m.model ? ' · ' + modelLabel(m.model) : '');
  const icon = isUser
    ? '<span class="message-footer-user" aria-hidden="true">●</span>'
    : '<img class="message-footer-avatar" src="' + escAttr(DATA.claudeIconUri) + '" alt="">';
  return '<div class="message-footer">' + icon + '<span>' + escHtml(label) + '</span></div>';
}

function outputDisplayName(output) {
  const href = String(output && output.href || '');
  if (/^https?:\\/\\/docs\\.google\\.com\\//i.test(href)) return output.title || output.kind;
  const clean = href.split(/[?#]/, 1)[0].replace(/\\/+$/, '');
  const rawName = clean.split('/').pop();
  if (!rawName) return output.title || href;
  try { return decodeURIComponent(rawName); } catch { return rawName; }
}

function renderOutputs(indices) {
  const outputs = [];
  const seen = new Set();
  indices.forEach((index) => (DATA.outputs[index] || []).forEach((output) => {
    if (!output || !output.href || seen.has(output.href)) return;
    seen.add(output.href);
    outputs.push(output);
  }));
  if (!outputs.length) return '';
  const rows = outputs.map((output) => {
    const copyLabel = /^https?:\\/\\//i.test(output.href) ? 'Copy full URL' : 'Copy full path';
    return '<div class="output-row">' +
      '<button class="output-chip" type="button" data-output-open="' + escAttr(output.href) + '" data-kind="' + escAttr(output.kind) + '" title="Open ' + escAttr(output.href) + '">' + escHtml(output.kind) + '</button>' +
      '<div class="output-main" title="' + escAttr(output.href) + '"><div class="output-title">' + escHtml(outputDisplayName(output)) + '</div></div>' +
      '<button class="output-copy" type="button" data-output-copy="' + escAttr(output.href) + '" aria-label="' + copyLabel + '" title="' + copyLabel + '">' + MESSAGE_COPY_ICON + '</button>' +
    '</div>';
  }).join('');
  return '<div class="outputs"><div class="outputs-head"><span>Output</span><span class="outputs-count">' + outputs.length + ' artifact' + (outputs.length === 1 ? '' : 's') + '</span></div>' + rows + '</div>';
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

function renderMessageBody(m, index, isCurrentMatch) {
  // The extractor already caps each message at 8,000 characters. Keep that
  // complete capped body here so the browser can measure real overflow rather
  // than guessing from source length or cutting Markdown before rendering.
  let html = renderSimpleMarkdown(m.text || '');
  html = highlightHtml(html, $('search').value.trim(), isCurrentMatch);
  return { html };
}

function syncFoldControls() {
  $('chat').querySelectorAll('.msg').forEach((msg) => {
    if (msg.classList.contains('filter-hidden')) return;
    const body = msg.querySelector('.bodywrap');
    const more = msg.querySelector('.more');
    if (!body || !more) return;
    const wasExpanded = !msg.classList.contains('folded');
    if (wasExpanded) msg.classList.add('folded');
    const overflow = body.scrollHeight > body.clientHeight + 1;
    if (wasExpanded) msg.classList.remove('folded');
    msg.dataset.hasOverflow = overflow ? 'true' : 'false';
    if (!overflow) {
      msg.classList.remove('folded');
      overrides.delete(Number(msg.dataset.i));
    }
    more.hidden = !overflow;
    more.textContent = msg.classList.contains('folded') ? 'Show more' : 'Show less';
    more.setAttribute('aria-expanded', msg.classList.contains('folded') ? 'false' : 'true');
  });
}

function toggleFoldInPlace(i) {
  const msg = $('chat').querySelector('.msg[data-i="' + i + '"]');
  if (!msg || msg.dataset.hasOverflow !== 'true') return;
  const chat = $('chat');
  const folded = msg.classList.toggle('folded');
  if (folded) {
    overrides.delete(i);
    // Show less: come back to where the reader was before expanding.
    const back = Number(msg.dataset.scrollBack);
    chat.scrollTo({ top: Number.isFinite(back) ? back : Math.max(0, msg.offsetTop - 10), behavior: 'instant' });
    delete msg.dataset.scrollBack;
  } else {
    overrides.add(i);
    // Show more: remember where we were, then anchor at the top of the
    // expanded message so reading starts from its beginning.
    msg.dataset.scrollBack = chat.scrollTop;
    chat.scrollTo({ top: Math.max(0, msg.offsetTop - 10), behavior: 'instant' });
  }
  const more = msg.querySelector('.more');
  if (more) {
    more.textContent = folded ? 'Show more' : 'Show less';
    more.setAttribute('aria-expanded', folded ? 'false' : 'true');
  }
  updateRail();
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

function applyFilterVisibility() {
  $('chat').querySelectorAll('.msg').forEach((msg) => {
    const visible = filter === 'all' || msg.classList.contains(filter);
    msg.classList.toggle('filter-hidden', !visible);
  });
  $('chat').querySelectorAll('.day').forEach((day) => {
    day.classList.toggle('filter-hidden', filter !== 'all');
  });
}

function rememberFilterAnchor() {
  const current = currentMessage();
  if (!current) return;
  const chat = $('chat');
  const chatRect = chat.getBoundingClientRect();
  filterAnchors.set(filter, {
    index: Number(current.dataset.i),
    offset: current.getBoundingClientRect().top - chatRect.top,
  });
}

function nearestVisibleMessage(index, targetFilter) {
  const candidates = Array.from($('chat').querySelectorAll('.msg'))
    .filter((msg) => !msg.classList.contains('filter-hidden'));
  if (!candidates.length) return null;
  const exact = candidates.find((msg) => Number(msg.dataset.i) === index);
  if (exact) return exact;
  const ordered = candidates.sort((a, b) => Number(a.dataset.i) - Number(b.dataset.i));
  if (targetFilter === 'assistant') {
    return ordered.find((msg) => Number(msg.dataset.i) >= index) || ordered[ordered.length - 1];
  }
  if (targetFilter === 'user') {
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (Number(ordered[i].dataset.i) <= index) return ordered[i];
    }
  }
  return ordered[0];
}

function restoreFilterAnchor(previousAnchor) {
  const saved = filterAnchors.get(filter) || previousAnchor;
  const target = saved ? nearestVisibleMessage(saved.index, filter) : currentMessage();
  if (!target) {
    updateRail();
    return;
  }
  const chat = $('chat');
  const chatRect = chat.getBoundingClientRect();
  const offset = saved && Number.isFinite(saved.offset) ? saved.offset : 32;
  chat.scrollTop = Math.max(0, chat.scrollTop + target.getBoundingClientRect().top - chatRect.top - offset);
  updateRail();
}

function setFilter(nextFilter) {
  if (!['all', 'assistant', 'user'].includes(nextFilter) || nextFilter === filter) return;
  const previousAnchor = (() => {
    rememberFilterAnchor();
    return filterAnchors.get(filter) || null;
  })();
  filter = nextFilter;
  document.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x.dataset.f === filter));
  matches = collectMatches();
  currentMatch = 0;
  applyFilterVisibility();
  // Class changes are synchronous, but wait one frame for the browser to
  // recalculate the filtered layout before restoring the semantic anchor.
  requestAnimationFrame(() => restoreFilterAnchor(previousAnchor));
  updateMatches(false);
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
  // Bubbles containing search matches must be readable: force-expand them.
  if ($('search').value.trim())
    matches.forEach(i => {
      const g = groupOf[i];
      if (g === undefined) return;
      overrides.add(g);
    });
  let lastDay = null;
  const frag = [];
  for (const g of groups) {
    const g0 = g.indices[0];
    const day = dayOf(msgs[g0].ts);
    if (day && day !== lastDay) { frag.push('<div class="day" data-day="' + (day || '') + '">' + day + '</div>'); lastDay = day; }
    const folded = !overrides.has(g0);
    const parts = g.indices.map(idx => {
      const m = msgs[idx];
      const body = renderMessageBody(m, idx, matches[currentMatch] === idx);
      const attachments = renderAttachments(m.attachments);
      return '<div class="part" data-i="' + idx + '">' + attachments + '<div class="body">' + body.html + '</div></div>';
    }).join('<div class="part-sep"></div>');
    const foldedClass = folded ? ' folded' : '';
    const moreButton = '<button class="more" data-fold="' + g0 + '" type="button" hidden aria-expanded="' + (!folded) + '">' + (folded ? 'Show more' : 'Show less') + '</button>';
    const outputs = g.role === 'assistant' ? renderOutputs(g.indices) : '';
    const copyButton = '<button class="msg-copy" data-copy="' + g.indices.join(',') + '" aria-label="Copy message" title="Copy message">' + MESSAGE_COPY_ICON + '</button>';
    const footer = messageFooter(msgs[g.indices[g.indices.length - 1]]);
    const foldLines = foldLinesForRole(g.role);
    const filterHidden = filter !== 'all' && g.role !== filter ? ' filter-hidden' : '';
    frag.push('<div class="msg ' + g.role + filterHidden + foldedClass + '" style="--message-fold-lines:' + foldLines + '" data-i="' + g0 + '" data-day="' + (day || '') + '"><div class="bodywrap">' + parts + '</div>' + moreButton + outputs + footer + copyButton + '</div>');
  }
  frag.push('<div class="bottom-spacer" aria-hidden="true"></div>');
  chat.insertAdjacentHTML('beforeend', frag.join(''));
  applyFilterVisibility();
  syncFoldControls();
  const rall = $('rall');
  if (rall) rall.onclick = () => { renderAll = true; render(); };
  chat.querySelectorAll('.copy-code').forEach(btn => btn.onclick = (e) => {
    e.stopPropagation();
    const code = btn.closest('pre').querySelector('code');
    if (code) navigator.clipboard.writeText(code.textContent).catch(() => {});
  });
  chat.querySelectorAll('.msg-copy').forEach(btn => btn.onclick = (e) => {
    e.stopPropagation();
    const indices = String(btn.dataset.copy || '').split(',').map(Number).filter(Number.isInteger);
    vscodeApi.postMessage({ type:'copyMessage', indices });
    btn.classList.add('copied');
    btn.innerHTML = '<span class="copied-mark" aria-hidden="true">✓</span>';
    btn.title = 'Copied';
    btn.setAttribute('aria-label', 'Copied');
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.classList.remove('copied');
      btn.innerHTML = MESSAGE_COPY_ICON;
      btn.title = 'Copy message';
      btn.setAttribute('aria-label', 'Copy message');
    }, 1400);
  });
  chat.querySelectorAll('[data-output-open]').forEach(btn => btn.onclick = (e) => {
    e.stopPropagation();
    vscodeApi.postMessage({ type:'openLink', href:btn.dataset.outputOpen });
  });
  chat.querySelectorAll('[data-output-copy]').forEach(btn => btn.onclick = (e) => {
    e.stopPropagation();
    vscodeApi.postMessage({ type:'copyOutput', value:btn.dataset.outputCopy });
    const originalTitle = btn.title;
    btn.innerHTML = '<span class="copied-mark" aria-hidden="true">✓</span>';
    btn.title = 'Copied';
    btn.setAttribute('aria-label', 'Copied');
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.innerHTML = MESSAGE_COPY_ICON;
      btn.title = originalTitle;
      btn.setAttribute('aria-label', originalTitle);
    }, 1400);
  });
  // Long bubbles expand only through their own control, matching the
  // progressive-disclosure behavior of the official Claude interface.
  chat.querySelectorAll('.more').forEach(el => el.onclick = (e) => {
    e.stopPropagation();
    toggleFoldInPlace(+el.dataset.fold);
  });
  updateMatches(false);
  if (keepScroll && !wasAtBottom) chat.scrollTop = prevScroll;
  else chat.scrollTop = chat.scrollHeight;
  updateRail();
}

function modelLabel(id) {
  const m = String(id || '').match(/claude-([a-z]+)/i);
  return m ? m[1][0].toUpperCase() + m[1].slice(1) : (id || 'Unknown');
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
  const bubbles = Array.from($('chat').querySelectorAll('.msg:not(.filter-hidden)'));
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
    DATA.outputs = m.outputs || DATA.messages.map(() => []);
    DATA.firstTs = m.firstTs;
    DATA.lastTs = m.lastTs;
    setRefreshing(false);
    render(true);
    return;
  }
  if (m.type === 'refreshError') setRefreshing(false);
});

function setRefreshing(value) {
  const btn = $('refreshViewer');
  if (!btn) return;
  btn.disabled = value;
  btn.classList.toggle('spinning', value);
  btn.setAttribute('aria-busy', value ? 'true' : 'false');
}

function setReaderScale(next) {
  readerScale = Math.min(1.25, Math.max(0.85, Math.round(next * 20) / 20));
  document.body.style.setProperty('--reader-scale', readerScale);
  vscodeApi.setState({ ...savedViewerState, readerScale });
}

$('refreshViewer').onclick = () => {
  if ($('refreshViewer').disabled) return;
  setRefreshing(true);
  vscodeApi.postMessage({ type:'refresh' });
};
$('revealInTree').onclick = () => vscodeApi.postMessage({ type:'revealInTree' });
$('openClaudeCode').onclick = () => vscodeApi.postMessage({ type:'openClaudeCode' });
$('resumeTerminal').onclick = () => vscodeApi.postMessage({ type:'resume' });
$('fontDown').onclick = () => setReaderScale(readerScale - 0.05);
$('fontUp').onclick = () => setReaderScale(readerScale + 0.05);
$('copyConversation').onclick = () => vscodeApi.postMessage({ type:'copy' });
$('searchToggle').onclick = () => {
  $('searchbar').classList.toggle('open');
  $('searchToggle').classList.toggle('open', $('searchbar').classList.contains('open'));
  if ($('searchbar').classList.contains('open')) $('search').focus();
};
$('modelToggle').onclick = () => {
  const visible = document.body.classList.toggle('footer-visible');
  document.body.classList.toggle('footer-hidden', !visible);
  $('modelToggle').classList.toggle('open', visible);
  $('modelToggle').setAttribute('aria-pressed', visible ? 'true' : 'false');
};
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
document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
  setFilter(b.dataset.f);
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

module.exports = { ConversationViewer, extractMessageOutputs };
