// #codex
// Combined Claude + Codex sidebar implemented as a VS Code WebviewView.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { indexAllCodex } = require('./codex-indexer');

const SESSION_CAP = 10;

function normalizedTimestamp(session) {
  return session.activityTs || session.lastMessageTs || '';
}

function folderExists(folderPath) {
  if (!folderPath) return false;
  try { return fs.statSync(folderPath).isDirectory(); } catch { return false; }
}

function folderLabel(folderPath) {
  if (!folderPath) return 'Unknown project';
  if (folderPath === os.homedir()) return 'No project';
  return path.basename(folderPath) || folderPath;
}

function parentHint(folderPath) {
  if (!folderPath || folderPath === os.homedir()) return '';
  const parent = path.dirname(folderPath);
  return parent === os.homedir() ? '~' : parent.replace(os.homedir(), '~');
}

function sessionActivities(session) {
  const candidates = Array.isArray(session.activities) ? session.activities : [];
  const activities = candidates
    .filter((activity) => activity && activity.ts && (activity.cwd || session.cwd) && !Number.isNaN(Date.parse(activity.ts)))
    .map((activity) => ({ ts: activity.ts, cwd: activity.cwd || session.cwd }));
  if (!activities.length && normalizedTimestamp(session) && session.cwd) {
    activities.push({ ts: normalizedTimestamp(session), cwd: session.cwd });
  }
  const unique = new Map();
  for (const activity of activities) unique.set(`${activity.ts}\u0000${activity.cwd}`, activity);
  return [...unique.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

function normalizeSessions(claudeProvider, claudeSessions, codexSessions) {
  const normalize = (session, source) => {
    const activities = sessionActivities(session);
    if (!activities.length) return null;
    const latest = activities[activities.length - 1];
    return {
      key: `${source}:${session.id}`,
      id: session.id,
      source,
      title: source === 'claude' ? claudeProvider.displayTitle(session) : session.title,
      cwd: latest.cwd,
      file: session.file,
      timestamp: latest.ts,
      mtimeMs: session.mtimeMs || 0,
      activities,
      raw: session,
    };
  };
  const combined = [
    ...claudeSessions.map((session) => normalize(session, 'claude')),
    ...codexSessions.map((session) => normalize(session, 'codex')),
  ].filter(Boolean);

  const projectPathsByLabel = new Map();
  for (const session of combined) {
    for (const activity of session.activities) {
      const label = folderLabel(activity.cwd);
      if (!projectPathsByLabel.has(label)) projectPathsByLabel.set(label, new Set());
      projectPathsByLabel.get(label).add(activity.cwd);
    }
  }
  for (const session of combined) {
    session.activities = session.activities.map((activity) => {
      const label = folderLabel(activity.cwd);
      const collision = projectPathsByLabel.get(label).size > 1;
      return {
        ...activity,
        folderPath: activity.cwd,
        folderLabel: label,
        folderExists: folderExists(activity.cwd),
        folderHint: collision ? parentHint(activity.cwd) : '',
        noProject: activity.cwd === os.homedir(),
      };
    });
    const latest = session.activities[session.activities.length - 1];
    Object.assign(session, latest);
  }
  combined.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || a.title.localeCompare(b.title));
  return combined;
}

function svg(name) {
  const icons = {
    refresh: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M13.4 3.7A6 6 0 1 0 14 9h-1.2A4.8 4.8 0 1 1 11.9 5L10 6.8h4V2.7z"/></svg>',
    calendar: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 1h1v2h6V1h1v2h1.5A1.5 1.5 0 0 1 15 4.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-9A1.5 1.5 0 0 1 2.5 3H4zm-2 6v6.5c0 .3.2.5.5.5h11c.3 0 .5-.2.5-.5V7zm.5-3a.5.5 0 0 0-.5.5V6h12V4.5a.5.5 0 0 0-.5-.5z"/></svg>',
    chevronRight: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="m6 3 5 5-5 5-.7-.7L9.6 8 5.3 3.7z"/></svg>',
    chevronDown: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="m3 6 5 5 5-5-.7-.7L8 9.6 3.7 5.3z"/></svg>',
  };
  return icons[name];
}

class SessionsWebviewProvider {
  constructor(context, claudeProvider, handlers = {}) {
    this.context = context;
    this.claudeProvider = claudeProvider;
    this.handlers = handlers;
    this.view = null;
    this.sessions = [];
    this.byKey = new Map();
    this.refreshToken = 0;
  }

  get codexCacheFile() {
    return path.join(this.context.globalStorageUri.fsPath, 'codex-session-index.json');
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'assets')],
    };
    view.webview.html = this.html(view.webview);
    this.context.subscriptions.push(
      view.webview.onDidReceiveMessage((message) => this.onMessage(message)),
      view.onDidChangeVisibility(() => { if (view.visible) this.refresh(); })
    );
    this.refresh();
  }

  async refresh() {
    const token = ++this.refreshToken;
    if (this.view) this.view.webview.postMessage({ type: 'loading' });
    try {
      this.claudeProvider.refresh();
      const [unused, codexSessions] = await Promise.all([
        this.claudeProvider.ensureLoaded(),
        indexAllCodex(this.codexCacheFile),
      ]);
      void unused;
      if (token !== this.refreshToken) return;
      const claudeSessions = this.claudeProvider.groups.flatMap((group) => group.sessions);
      this.sessions = normalizeSessions(this.claudeProvider, claudeSessions, codexSessions);
      this.byKey = new Map(this.sessions.map((session) => [session.key, session]));
      if (this.view) {
        this.view.webview.postMessage({
          type: 'sessions',
          sessions: this.sessions.map(({ raw, ...session }) => session),
        });
      }
    } catch (error) {
      if (this.view) this.view.webview.postMessage({ type: 'error', message: error.message });
      vscode.window.showErrorMessage(`Session Viewer: could not index sessions — ${error.message}`);
    }
  }

  async revealSession(sessionId, source = null) {
    if (!this.sessions.length) await this.refresh();
    const session = this.sessions.find((candidate) =>
      candidate.id === sessionId && (!source || candidate.source === source)
    );
    if (!session) return false;
    await vscode.commands.executeCommand('workbench.view.extension.claudeSessions');
    if (this.view) {
      this.view.show?.(true);
      this.view.webview.postMessage({ type: 'reveal', key: session.key });
    }
    return true;
  }

  // Resolves a normalized session for a given (key, cwd) pair — the same
  // shape the row action buttons and the native right-click menu both act on.
  // cwd disambiguates which of a session's several project folders was
  // clicked; falls back to the most recent one when omitted or unmatched.
  resolveSession(key, cwd) {
    const base = this.byKey.get(String(key || ''));
    if (!base) return null;
    const activity = base.activities.find((candidate) => candidate.folderPath === cwd) || base.activities.at(-1);
    return { ...base, ...activity, cwd: activity.folderPath };
  }

  async onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready' || message.type === 'refresh') {
      await this.refresh();
      return;
    }
    if (message.type !== 'action') return;
    const session = this.resolveSession(message.key, message.cwd);
    if (!session) return;
    const handler = this.handlers[message.action];
    if (typeof handler !== 'function') return;
    try {
      const result = await handler(session);
      if (result && this.view) this.view.webview.postMessage({ type: 'toast', message: result });
    } catch (error) {
      vscode.window.showErrorMessage(`Session Viewer: ${error.message}`);
    }
  }

  html(webview) {
    const nonce = Math.random().toString(36).slice(2);
    const asset = (name) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'assets', name)).toString();
    const icons = {
      claudeDark: asset('claude-code-logo-dark.svg'), claudeLight: asset('claude-code-logo-light.svg'),
      codexDark: asset('codex-logo.svg'), codexLight: asset('codex-logo.svg'),
      folderDark: asset('folder-neutral-dark.svg'), folderLight: asset('folder-neutral-light.svg'),
      openDark: asset('tree-open-preview-dark.svg'), openLight: asset('tree-open-preview-light.svg'),
      terminalDark: asset('tree-terminal-dark.svg'), terminalLight: asset('tree-terminal-light.svg'),
      copyDark: asset('tree-copy-dark.svg'), copyLight: asset('tree-copy-light.svg'),
    };
    const iconData = JSON.stringify(icons).replace(/</g, '\\u003c');
    const glyphData = JSON.stringify({
      chevronDown: svg('chevronDown'),
      chevronRight: svg('chevronRight'),
    }).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
*{box-sizing:border-box}html,body{height:100%;margin:0}body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);overflow:auto}.shell{min-height:100%;padding:8px 8px 20px}.head{height:28px;display:flex;align-items:center;padding:0 3px 5px;color:var(--vscode-descriptionForeground)}.crumb{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:10.5px;letter-spacing:.04em}.crumb b{color:var(--vscode-foreground);font-weight:600}.sep{margin:0 4px;opacity:.58}.iconbtn{width:24px;height:24px;border:0;border-radius:5px;background:transparent;color:var(--vscode-icon-foreground);display:flex;align-items:center;justify-content:center;padding:4px;cursor:pointer}.iconbtn:hover,.iconbtn:focus-visible{background:var(--vscode-toolbar-hoverBackground);outline:none}.iconbtn svg{width:15px;height:15px}.iconbtn.spinning svg{animation:spin .8s linear infinite}.toolbar{border-top:1px solid var(--vscode-sideBarSectionHeader-border,transparent);border-bottom:1px solid var(--vscode-sideBarSectionHeader-border,transparent);padding:6px 2px}.control-row{display:flex;align-items:center;min-width:0;height:30px}.control-row+.control-row{margin-top:3px}.label{width:48px;flex:0 0 48px;color:var(--vscode-descriptionForeground);font-size:11px}.seg{display:flex;min-width:0;border:1px solid var(--vscode-panel-border);border-radius:6px;overflow:hidden;background:var(--vscode-sideBar-background)}.seg button{height:25px;border:0;border-right:1px solid var(--vscode-panel-border);background:transparent;color:var(--vscode-descriptionForeground);font:inherit;font-size:11px;display:flex;align-items:center;gap:5px;padding:0 8px;white-space:nowrap;cursor:pointer}.seg button:last-child{border-right:0}.seg button:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-foreground)}.seg button.on{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.seg svg{width:13px;height:13px}.src-img{width:13px;height:13px;object-fit:contain;opacity:.8}.tree{padding-top:7px}.bucket{padding:11px 5px 4px;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:500;text-transform:none}.bucket.archive{display:flex;align-items:center;gap:3px;cursor:pointer;border-radius:4px;padding-top:9px}.bucket.archive:hover{background:var(--vscode-list-hoverBackground)}.bucket svg{width:13px;height:13px}.project-row{height:28px;display:flex;align-items:center;padding:0 3px;border-radius:4px;cursor:pointer;color:var(--vscode-descriptionForeground);min-width:0}.project-row.history{margin-left:5px}.project-row:hover{background:var(--vscode-list-hoverBackground)}.project-row svg{width:13px;height:13px;flex:0 0 13px}.project-row img{width:14px;height:14px;flex:0 0 14px;margin:0 6px 0 2px}.project-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-foreground)}.project-hint{flex:1 1 auto;min-width:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:6px;font-size:10px}.count{flex:0 0 auto;margin-left:6px;font-size:10.5px}.missing{flex:0 0 auto;margin-left:5px;font-size:9.5px;color:var(--vscode-descriptionForeground)}.session-list.history{margin-left:20px}.session-list.folder{margin-left:17px}.session{position:relative;min-height:31px;padding:5px 4px 5px 4px;border-radius:4px;cursor:default}.session:hover{background:var(--vscode-list-hoverBackground)}.session.selected{background:var(--vscode-list-inactiveSelectionBackground)}.line1{display:flex;align-items:center;min-width:0;height:18px;padding-right:3px}.provider{width:15px;height:15px;flex:0 0 15px;margin-right:5px;object-fit:contain;opacity:.82}.age{color:var(--vscode-descriptionForeground);font-size:10.5px;flex:0 0 auto;margin-right:5px}.title{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}.actions{display:flex;position:absolute;right:2px;top:4px;padding-left:12px;background:linear-gradient(90deg,transparent,var(--vscode-list-hoverBackground) 12px);opacity:0;pointer-events:none}.session:hover .actions,.session:focus-within .actions{opacity:1;pointer-events:auto}.action{width:23px;height:23px;border:0;border-radius:4px;background:var(--vscode-list-hoverBackground);padding:4px;display:flex;align-items:center;justify-content:center;cursor:pointer}.action:hover,.action:focus-visible{background:var(--vscode-toolbar-hoverBackground);outline:none}.action:disabled{opacity:.32;cursor:not-allowed}.action img{width:14px;height:14px;object-fit:contain}.more{height:29px;margin-left:20px;border:0;background:transparent;color:var(--vscode-textLink-foreground);font:inherit;font-size:11px;cursor:pointer}.more:hover{text-decoration:underline}.state{padding:28px 8px;text-align:center;color:var(--vscode-descriptionForeground);font-size:11px}.toast{position:fixed;left:50%;bottom:12px;transform:translate(-50%,8px);max-width:calc(100% - 24px);padding:5px 9px;border:1px solid var(--vscode-notifications-border);border-radius:5px;background:var(--vscode-notifications-background);color:var(--vscode-notifications-foreground);font-size:10.5px;opacity:0;pointer-events:none;transition:.15s;z-index:20;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.toast.show{opacity:1;transform:translate(-50%,0)}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:275px){.label{width:42px;flex-basis:42px}.seg button{padding:0 6px}.actions{position:static;opacity:1;pointer-events:auto;background:none;padding:2px 0 0 19px}.session{padding-right:2px}}
</style></head><body><main class="shell">
  <header class="head"><div class="crumb" id="crumb"></div><button class="iconbtn" id="refresh" aria-label="Refresh sessions" title="Refresh sessions">${svg('refresh')}</button></header>
  <section class="toolbar" aria-label="Session controls">
    <div class="control-row"><span class="label">Group</span><div class="seg" id="groupSeg"><button data-mode="date">${svg('calendar')}Date</button><button data-mode="folder"><img class="src-img" src="${icons.folderDark}" alt="">Folder</button></div></div>
    <div class="control-row"><span class="label">Source</span><div class="seg" id="sourceSeg"><button data-source="all">All</button><button data-source="claude"><img class="src-img" src="${icons.claudeDark}" alt="">Claude</button><button data-source="codex"><img class="src-img" src="${icons.codexDark}" alt="">Codex</button></div></div>
  </section>
  <section class="tree" id="tree"><div class="state">Loading sessions…</div></section>
</main><div class="toast" id="toast"></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(),ICONS=${iconData},GLYPHS=${glyphData},CAP=${SESSION_CAP};
let sessions=[],loading=true;
const saved=vscode.getState()||{};
let mode=saved.mode==='folder'?'folder':'date',source=['all','claude','codex'].includes(saved.source)?saved.source:'all';
let selected=saved.selected||'',openProjects=new Set(saved.openProjects||[]),closedHistory=new Set(saved.closedHistory||[]),expanded=new Set(saved.expanded||[]),archiveOpen=saved.archiveOpen===true;
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function persist(){vscode.setState({mode,source,selected,openProjects:[...openProjects],closedHistory:[...closedHistory],expanded:[...expanded],archiveOpen})}
function icon(name){return ICONS[name+(document.body.classList.contains('vscode-light')?'Light':'Dark')]}
function age(ts){const n=Math.max(0,Date.now()-Date.parse(ts)),m=Math.floor(n/60000);if(m<1)return'now';if(m<60)return m+'m';const h=Math.floor(m/60);if(h<24)return h+'h';const d=Math.floor(h/24);return d<30?d+'d':Math.floor(d/30)+'mo'}
function dayKey(ts){const d=new Date(ts);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function dayLabel(ts){const d=new Date(ts),today=new Date(),y=new Date();y.setDate(y.getDate()-1);if(dayKey(d)===dayKey(today))return'Today';if(dayKey(d)===dayKey(y))return'Yesterday';return new Intl.DateTimeFormat(undefined,{day:'numeric',month:'short',year:d.getFullYear()===today.getFullYear()?undefined:'numeric'}).format(d)}
function logo(s){return icon(s.source==='codex'?'codex':'claude')}
function actionButton(action,label,image,disabled){return '<button class="action" data-action="'+action+'" title="'+esc(label)+'" aria-label="'+esc(label)+'"'+(disabled?' disabled':'')+'><img src="'+image+'" alt=""></button>'}
function sessionRow(s){const row=document.createElement('div');row.className='session'+(selected===s.key?' selected':'');row.tabIndex=0;row.dataset.key=s.key;const unavailable=!s.folderExists;const officialDisabled=s.source==='claude'&&unavailable;row.title=s.title+'\\n'+s.folderPath+(unavailable?'\\nFolder no longer exists':'');row.setAttribute('data-vscode-context',JSON.stringify({webviewSection:'session',key:s.key,cwd:s.folderPath,preventDefaultContextMenuItems:true}));row.innerHTML='<div class="line1"><img class="provider" src="'+logo(s)+'" alt="'+esc(s.source)+'"><span class="age">['+age(s.timestamp)+']</span><span class="title">'+esc(s.title)+'</span></div><div class="actions">'+actionButton('open','Open transcript in Session Viewer',icon('open'),false)+actionButton('official','Open exact session in '+(s.source==='codex'?'Codex':'Claude Code'),logo(s),officialDisabled)+actionButton('resume',unavailable?'Folder no longer exists':'Resume in terminal',icon('terminal'),unavailable)+actionButton('copy','Copy session file path',icon('copy'),false)+'</div>';row.onclick=e=>{if(e.target.closest('.action'))return;selected=s.key;persist();render()};row.querySelectorAll('.action').forEach(button=>button.onclick=e=>{e.stopPropagation();if(button.disabled)return;vscode.postMessage({type:'action',action:button.dataset.action,key:s.key,cwd:s.folderPath})});return row}
function showMore(key,list,container,kind){const wrap=document.createElement('div');wrap.className='session-list '+kind;const shown=expanded.has(key)?list.length:Math.min(CAP,list.length);list.slice(0,shown).forEach(s=>wrap.appendChild(sessionRow(s)));if(shown<list.length){const b=document.createElement('button');b.className='more';b.textContent='Show '+(list.length-shown)+' more ('+list.length+' total)';b.onclick=()=>{expanded.add(key);persist();render()};wrap.appendChild(b)}container.appendChild(wrap)}
function projectRow(project,key,open,kind){const row=document.createElement('div');row.className='project-row '+kind;row.title=project.path+(project.exists?'':'\\nFolder no longer exists');row.innerHTML=(open?GLYPHS.chevronDown:GLYPHS.chevronRight)+'<img src="'+icon('folder')+'" alt=""><span class="project-name">'+esc(project.label)+'</span>'+(project.hint?'<span class="project-hint">'+esc(project.hint)+'</span>':'')+'<span class="count">('+project.items.length+')</span>'+(!project.exists&&!project.noProject?'<span class="missing">missing</span>':'');row.onclick=()=>{if(kind==='history'){open?closedHistory.add(key):closedHistory.delete(key)}else{open?openProjects.delete(key):openProjects.add(key)}persist();render()};return row}
function activityRows(items){const rows=[];for(const s of items){for(const a of s.activities){rows.push({...s,...a,timestamp:a.ts,cwd:a.folderPath})}}return rows.sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp)||a.title.localeCompare(b.title))}
function projectGroups(rows){const groups=new Map();for(const s of rows){const key=s.folderPath;if(!groups.has(key))groups.set(key,{path:key,label:s.folderLabel,hint:s.folderHint,exists:s.folderExists,noProject:s.noProject,latest:s.timestamp,items:[]});const g=groups.get(key);if(Date.parse(s.timestamp)>Date.parse(g.latest))g.latest=s.timestamp;const old=g.items.find(i=>i.key===s.key);if(!old)g.items.push(s);else if(Date.parse(s.timestamp)>Date.parse(old.timestamp))Object.assign(old,s)}for(const g of groups.values())g.items.sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp)||a.title.localeCompare(b.title));return [...groups.values()].sort((a,b)=>Date.parse(b.latest)-Date.parse(a.latest)||a.label.localeCompare(b.label)||a.path.localeCompare(b.path))}
function renderDate(items,tree){const days=new Map();for(const s of activityRows(items)){const key=dayKey(s.timestamp);if(!days.has(key))days.set(key,{label:dayLabel(s.timestamp),latest:s.timestamp,items:[]});days.get(key).items.push(s)}for(const [day,g] of days){const h=document.createElement('div');h.className='bucket';h.textContent=g.label;tree.appendChild(h);for(const project of projectGroups(g.items)){const key='history:'+day+':'+project.path,open=!closedHistory.has(key);tree.appendChild(projectRow(project,key,open,'history'));if(open)showMore(key,project.items,tree,'history')}}}
function renderProjectList(groups,tree,prefix){for(const project of groups){const key=prefix+':'+project.path,open=openProjects.has(key);tree.appendChild(projectRow(project,key,open,'folder'));if(open)showMore(key,project.items,tree,'folder')}}
function renderFolder(items,tree){const groups=projectGroups(activityRows(items)),active=groups.filter(g=>g.exists||g.noProject),archived=groups.filter(g=>!g.exists&&!g.noProject);renderProjectList(active,tree,'folder');if(archived.length){const h=document.createElement('div');h.className='bucket archive';h.innerHTML=(archiveOpen?GLYPHS.chevronDown:GLYPHS.chevronRight)+'<span>Archived locations ('+archived.length+')</span>';h.onclick=()=>{archiveOpen=!archiveOpen;persist();render()};tree.appendChild(h);if(archiveOpen)renderProjectList(archived,tree,'archive')}}
function controls(){document.querySelectorAll('#groupSeg button').forEach(b=>b.classList.toggle('on',b.dataset.mode===mode));document.querySelectorAll('#sourceSeg button').forEach(b=>b.classList.toggle('on',b.dataset.source===source));const src=source==='all'?'All':source[0].toUpperCase()+source.slice(1),grp=mode==='date'?'History by Date':'Projects by Folder';$('crumb').innerHTML='<b>SESSION VIEWER</b><span class="sep">··</span>'+src+'<span class="sep">·</span>'+grp}
function render(){controls();const tree=$('tree');tree.innerHTML='';if(loading){tree.innerHTML='<div class="state">Loading sessions…</div>';return}const items=sessions.filter(s=>source==='all'||s.source===source).sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp));if(!items.length){tree.innerHTML='<div class="state">No sessions with recorded work match this source.</div>';return}mode==='date'?renderDate(items,tree):renderFolder(items,tree)}
function toast(message){const t=$('toast');t.textContent=message;t.classList.add('show');clearTimeout(t._timer);t._timer=setTimeout(()=>t.classList.remove('show'),1800)}
$('groupSeg').querySelectorAll('button').forEach(b=>b.onclick=()=>{mode=b.dataset.mode;persist();render()});$('sourceSeg').querySelectorAll('button').forEach(b=>b.onclick=()=>{source=b.dataset.source;persist();render()});$('refresh').onclick=()=>{loading=true;$('refresh').classList.add('spinning');render();vscode.postMessage({type:'refresh'})};
window.addEventListener('message',event=>{const m=event.data;if(m.type==='loading'){loading=true;$('refresh').classList.add('spinning');render()}else if(m.type==='sessions'){sessions=m.sessions||[];loading=false;$('refresh').classList.remove('spinning');render()}else if(m.type==='error'){loading=false;$('refresh').classList.remove('spinning');$('tree').innerHTML='<div class="state">'+esc(m.message||'Could not load sessions.')+'</div>'}else if(m.type==='toast')toast(m.message);else if(m.type==='reveal'){mode='date';source='all';selected=m.key;persist();render();setTimeout(()=>document.querySelector('[data-key="'+CSS.escape(m.key)+'"]')?.scrollIntoView({block:'center'}),0)}});
render();vscode.postMessage({type:'ready'});
</script></body></html>`;
  }
}

module.exports = { SessionsWebviewProvider, normalizeSessions, normalizedTimestamp, sessionActivities, SESSION_CAP };
