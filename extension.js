const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { indexAll, isAutomationSession } = require('./indexer');
const { ConversationViewer } = require('./viewer');
const { SessionsWebviewProvider } = require('./sessions-view');

const TIMELINE_TITLE_MAX = 48;
const LIVE_WINDOW_MS = 5 * 60 * 1000;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isLiveSession(session, now = Date.now()) {
  return !!(session && session.mtimeMs && now - session.mtimeMs < LIVE_WINDOW_MS);
}

function relativeAge(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}

function shortHome(p) {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function normalizeTitleForMatch(s) {
  return String(s || '')
    .replace(/^[*●✳✻\s]+/, '')
    .replace(/\s+[—-]\s+.*$/, '')
    .replace(/[.…]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function truncateTitle(title, max = TIMELINE_TITLE_MAX) {
  const value = String(title || '');
  if (value.length <= max) return value;
  return value.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

function tooltipDate(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '?';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function tooltipDuration(startIso, endIso) {
  const start = startIso ? Date.parse(startIso) : NaN;
  const end = endIso ? Date.parse(endIso) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '?';
  const minutes = Math.round((end - start) / 60000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const exact = remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  if (hours < 24) return exact;
  return `~${Math.floor(hours / 24)}d (${exact})`;
}

function wrapTooltipText(value, maxChars = 72) {
  const words = String(value || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function tooltipMessageExcerpt(session) {
  const head = String(session.lastMessage || session.lastPrompt || '').replace(/\s+/g, ' ').trim();
  if (!head) return { start: ['No readable message'], end: [] };
  const totalLength = Number(session.lastMessageLength) || head.length;
  const tail = String(session.lastMessageTail || '').replace(/\s+/g, ' ').trim();
  if (!tail || totalLength <= head.length) return { start: wrapTooltipText(head), end: [] };

  const start = wrapTooltipText(head).slice(0, 2);
  if (start.length) start[start.length - 1] += '…';

  // Keep the real ending visible without parsing the full transcript on hover.
  // The indexer stores a compact tail specifically for this preview.
  const overlap = Math.max(0, head.length + tail.length - totalLength);
  const ending = tail.slice(overlap).trimStart();
  if (!ending) return { start, end: [] };
  const end = wrapTooltipText(ending).slice(-4);
  if (end.length) end[0] = `…${end[0]}`;
  return { start, end };
}

// Two different projects can share a folder basename (e.g. two "backend"
// checkouts). Mark groups whose label is ambiguous so the tree can show the
// parent folder as a tiebreaker, without reverting to full paths everywhere.
function markLabelCollisions(groups) {
  const pathsByLabel = new Map();
  for (const g of groups) {
    if (!pathsByLabel.has(g.label)) pathsByLabel.set(g.label, new Set());
    pathsByLabel.get(g.label).add(g.folderPath);
  }
  for (const g of groups) {
    g.labelCollision = pathsByLabel.get(g.label).size > 1;
  }
}

function titleMatchScore(activeTitle, candidateTitle) {
  const active = normalizeTitleForMatch(activeTitle);
  const candidate = normalizeTitleForMatch(candidateTitle);
  if (!active || !candidate) return 0;
  if (active === candidate) return 1000 + candidate.length;
  if (candidate.startsWith(active) || active.startsWith(candidate)) return 800 + Math.min(active.length, candidate.length);
  if (active.length >= 10 && candidate.includes(active)) return 600 + active.length;
  if (candidate.length >= 10 && active.includes(candidate)) return 500 + candidate.length;
  return 0;
}

class SessionTreeProvider {
  constructor(context) {
    this.context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.groups = []; // folders mode: [{ id, label, folderPath, sessions: [...] }]
    this.timeline = []; // timeline mode: flat [{ kind:'session', session, group }]
    this.loaded = false;
    this.loading = null;
    this.expandedAll = false;
    this.expansionRevision = 0;
    this.selectedSessionId = context.globalState.get('selectedSessionId', null);
    // 'folders' = one row per folder, A-Z, with all sessions inside.
    // 'chronological' = flat session timeline, newest first, across folders
    // ('chronological' kept as the stored value for back-compat).
    this.treeMode = context.globalState.get('treeMode', 'folders');
    if (this.treeMode === 'chronological' && !this.config.timelineEnabled) this.treeMode = 'folders';
  }

  async toggleGrouping() {
    if (!this.config.timelineEnabled) {
      this.treeMode = 'folders';
      this.context.globalState.update('treeMode', this.treeMode);
      this.updateModeUi();
      vscode.window.showInformationMessage('Claude Sessions: timeline is experimental and disabled in Settings.');
      return;
    }
    const sessionId = this.selectedSessionId;
    if (sessionId) this.context.globalState.update('selectedSessionId', sessionId);
    this.treeMode = this.treeMode === 'folders' ? 'chronological' : 'folders';
    this.context.globalState.update('treeMode', this.treeMode);
    this.updateModeUi();
    vscode.window.setStatusBarMessage(
      this.treeMode === 'folders'
        ? 'Claude Sessions: folders A-Z.'
        : 'Claude Sessions: session timeline — newest first.',
      3500
    );
    this.refresh();
    if (sessionId && this.view) {
      await this.ensureLoaded();
      await this.revealSessionById(sessionId);
    }
  }

  setExpandedAll(expanded) {
    if (this.expandedAll === expanded) return;
    this.expandedAll = expanded;
    this.expansionRevision++;
    this.updateModeUi();
    this._onDidChangeTreeData.fire();
  }

  rememberSession(node) {
    if (!node || node.kind !== 'session' || !node.session || !node.session.id) return;
    this.selectedSessionId = node.session.id;
    this.context.globalState.update('selectedSessionId', node.session.id);
  }

  // Plain tree clicks fire onDidChangeSelection constantly while browsing;
  // track the selection in memory only there. It gets flushed to disk by
  // rememberSession() (open/reveal command paths) or toggleGrouping().
  setSelectionInMemory(node) {
    if (!node || node.kind !== 'session' || !node.session || !node.session.id) return;
    this.selectedSessionId = node.session.id;
  }

  async revealSessionById(sessionId, opts = {}) {
    if (!sessionId || !this.view) return false;
    const node = this.allSessions().find((n) => n.session.id === sessionId);
    if (!node) return false;
    this.rememberSession(node);
    try {
      await this.view.reveal(node, {
        select: opts.select !== false,
        expand: true,
        focus: opts.focus === true,
      });
      return true;
    } catch {
      return false;
    }
  }

  // Persistent mode indicator: text next to the view title + which title buttons
  // are shown via context keys.
  updateModeUi() {
    if (this.view) {
      const isFolders = this.treeMode === 'folders';
      const mode = isFolders ? 'folders A-Z' : 'newest first';
      this.view.title = isFolders ? 'Sessions by Folder' : 'Session Timeline';
      this.view.description = this.loaded ? mode : `${mode} · indexing`;
    }
    vscode.commands.executeCommand('setContext', 'claudeSessions.mode', this.treeMode);
    vscode.commands.executeCommand('setContext', 'claudeSessions.expandedAll', this.expandedAll);
    vscode.commands.executeCommand('setContext', 'claudeSessions.timelineEnabled', this.config.timelineEnabled);
  }

  get cacheFile() {
    return path.join(this.context.globalStorageUri.fsPath, 'session-index.json');
  }

  get workspaceRoot() {
    const ws = vscode.workspace.workspaceFolders;
    return ws && ws.length ? ws[0].uri.fsPath : null;
  }

  get config() {
    const c = vscode.workspace.getConfiguration('claudeSessionsViewer');
    return {
      promptChildren: c.get('promptChildren.enabled', false),
      showAutomation: c.get('showAutomationSessions', false),
      timelineEnabled: c.get('timeline.enabled', false),
      revealEnabled: c.get('reveal.enabled', true),
      revealOpenConversation: c.get('reveal.openConversation', true),
      userLabel: String(c.get('userLabel', 'USER') || 'USER').trim().slice(0, 40) || 'USER',
      agentLabel: String(c.get('agentLabel', 'CLAUDE') || 'CLAUDE').trim().slice(0, 40) || 'CLAUDE',
    };
  }

  refresh() {
    this.loaded = false;
    this.loading = null;
    this._onDidChangeTreeData.fire();
  }

  // Like refresh(), but returns the re-index promise so callers can await the
  // tree fully settling before touching tree nodes (e.g. view.reveal).
  refreshAndLoad() {
    this.refresh();
    return this.ensureLoaded();
  }

  loadingNode() {
    return { kind: 'loading' };
  }

  folderForSession(s, root) {
    // The transcript cwd is ground truth; do not re-file root sessions based on
    // path mentions inside the conversation.
    if (!s.cwd) return null;
    if (root && s.cwd === root) {
      return { folderPath: root, label: this.folderLabel(root) };
    }
    if (root && s.cwd.startsWith(root + path.sep)) {
      const seg = s.cwd.slice(root.length + 1).split(path.sep)[0];
      const folderPath = path.join(root, seg);
      return { folderPath, label: this.folderLabel(folderPath) };
    }
    return { folderPath: s.cwd, label: this.folderLabel(s.cwd) };
  }

  folderLabel(folderPath) {
    if (!folderPath) return '';
    if (folderPath === os.homedir()) return '~';
    return path.basename(folderPath) || shortHome(folderPath);
  }

  buildFolderGroups(sessions, root) {
    const map = new Map();
    for (const s of sessions) {
      const attr = this.folderForSession(s, root);
      if (!attr) continue;
      const key = attr.folderPath;
      if (!map.has(key)) {
        map.set(key, {
          id: `f:${attr.folderPath}`,
          label: attr.label,
          folderPath: attr.folderPath,
          sessions: [],
        });
      }
      map.get(key).sessions.push(s);
    }
    const groups = [...map.values()];
    for (const g of groups) {
      g.sessions.sort((a, b) => (b.effTs || b.lastTs || '').localeCompare(a.effTs || a.lastTs || ''));
      g.latest = g.sessions[0] ? g.sessions[0].effTs || g.sessions[0].lastTs || '' : '';
    }
    groups.sort((a, b) => a.label.localeCompare(b.label) || a.folderPath.localeCompare(b.folderPath));
    markLabelCollisions(groups);
    return groups;
  }

  // The session timeline: a FLAT list of sessions, newest first, across all
  // folders — the cross-project "order of my work" view for someone working
  // in several folders at once. No folder wrapper rows (that is what makes it
  // visually distinct from folders mode); each row carries its folder name in
  // the description, and "Show in folder view" jumps to the session's place.
  buildTimeline(sessions, root) {
    const nodes = [];
    for (const s of sessions) {
      const attr = this.folderForSession(s, root);
      if (!attr) continue;
      nodes.push({ kind: 'session', session: s, group: { label: attr.label, folderPath: attr.folderPath } });
    }
    nodes.sort((a, b) =>
      (b.session.effTs || b.session.lastTs || '').localeCompare(a.session.effTs || a.session.lastTs || '')
    );
    return nodes;
  }

  async ensureLoaded() {
    if (this.loaded) return;
    if (!this.loading) {
      this.updateModeUi();
      this.loading = vscode.window.withProgress(
        { location: { viewId: 'claudeSessions.tree' }, title: 'Indexing Claude sessions…' },
        async () => {
          const indexed = await indexAll(this.cacheFile, undefined, {
            includePrompts: this.config.promptChildren,
          });
          // Resuming a session from another directory copies its transcript
          // into that project dir — same session id in several files. Keep
          // the freshest copy only.
          const byId = new Map();
          for (const s of indexed) {
            const prev = byId.get(s.id);
            if (!prev || (s.mtimeMs || 0) > (prev.mtimeMs || 0)) byId.set(s.id, s);
          }
          // Hide SDK-launched automation shells (/security-review runs,
          // agents) unless the user opts in — the official Claude panel does
          // the same, and it is the difference between 29 rows and 4.
          const showAutomation = this.config.showAutomation;
          const sessions = [...byId.values()].filter((s) => showAutomation || !isAutomationSession(s));
          const root = this.workspaceRoot;
          this.groups = this.buildFolderGroups(sessions, root);
          this.timeline = this.treeMode === 'chronological' ? this.buildTimeline(sessions, root) : [];
          this.loaded = true;
          this.updateModeUi();
          this._onDidChangeTreeData.fire();
        }
      );
    }
    await this.loading;
  }

  displayTitle(s) {
    const custom = this.context.globalState.get('customTitles', {})[s.id];
    return custom || s.title || s.firstPrompt || s.lastPrompt || s.id.slice(0, 8);
  }

  titleCandidates(s) {
    return [this.displayTitle(s), s.title, s.firstPrompt, s.lastPrompt, s.id].filter(Boolean);
  }

  findByActiveTabTitle(nodes, activeTabTitle) {
    const scored = [];
    for (const n of nodes) {
      let score = 0;
      for (const candidate of this.titleCandidates(n.session)) {
        score = Math.max(score, titleMatchScore(activeTabTitle, candidate));
      }
      if (score > 0) scored.push({ node: n, score });
    }
    scored.sort((a, b) => b.score - a.score || (b.node.session.mtimeMs || 0) - (a.node.session.mtimeMs || 0));
    return scored[0] ? scored[0].node : null;
  }

  allSessions() {
    if (this.treeMode === 'chronological') return this.timeline || [];
    return this.groups.flatMap((g) => g.sessions.map((s) => ({ kind: 'session', session: s, group: g })));
  }

  groupContainsSelectedSession(group) {
    return !!(
      this.selectedSessionId &&
      group &&
      group.sessions &&
      group.sessions.some((s) => s.id === this.selectedSessionId)
    );
  }

  getParent(element) {
    if (element.kind === 'session') {
      if (this.treeMode === 'chronological') return null;
      return { kind: 'folder', group: element.group };
    }
    if (element.kind === 'prompt' && element.parent) return element.parent;
    return null;
  }

  async getChildren(element) {
    const roots = () =>
      this.treeMode === 'chronological'
        ? this.timeline || []
        : this.groups.map((g) => ({ kind: 'folder', group: g }));
    if (!this.loaded) {
      this.ensureLoaded().catch(() => {});
      if (!element) {
        const r = roots();
        return r.length ? r : [this.loadingNode()];
      }
      return [];
    }
    if (!element) {
      return roots();
    }
    if (element.kind === 'folder') {
      return element.group.sessions.map((s) => ({ kind: 'session', session: s, group: element.group }));
    }
    if (element.kind === 'session') {
      if (!this.config.promptChildren) return [];
      return (element.session.prompts || []).map((p, i) => ({ kind: 'prompt', text: p, index: i, parent: element }));
    }
    return [];
  }

  getTreeItem(element) {
    if (element.kind === 'loading') {
      const item = new vscode.TreeItem('Indexing Claude sessions...', vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('loading~spin');
      item.description = 'first run can take a moment';
      item.contextValue = 'loading';
      return item;
    }
    if (element.kind === 'folder') {
      const g = element.group;
      const keepRevealedOpen = this.groupContainsSelectedSession(g);
      const isExpanded = this.expandedAll || keepRevealedOpen;
      const item = new vscode.TreeItem(
        g.label,
        isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
      );
      // VS Code preserves expansion state by TreeItem.id. Include a small
      // revision so the explicit expand/collapse toolbar button can override
      // the user's previous manual expansion state, while the currently
      // revealed session's folder remains open after collapse-all.
      item.id = `${g.id}:${this.expansionRevision}:${isExpanded ? 'open' : 'closed'}:${keepRevealedOpen ? this.selectedSessionId : ''}`;
      let exists = true;
      try {
        exists = fs.statSync(g.folderPath).isDirectory();
      } catch {
        exists = false;
      }
      // Two projects can share a folder basename; disambiguate only the
      // colliding groups with their shortened parent path.
      const parentHint = g.labelCollision ? shortHome(path.dirname(g.folderPath)) : '';
      const countPart = `(${g.sessions.length})`;
      const statusPart = exists ? '' : 'gone';
      item.description = [parentHint, countPart, statusPart].filter(Boolean).join(' · ');
      // Folder rows are navigation anchors, not activity indicators. Use a
      // folder-only asset so the expand arrow is the only disclosure signal.
      item.iconPath = {
        light: vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'folder-tree-light.svg'),
        dark: vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'folder-tree-dark.svg'),
      };
      item.contextValue = 'folder';
      item.tooltip = exists
        ? g.folderPath
        : `${g.folderPath}\n\nThis folder no longer exists on disk — the sessions recorded here are kept as history.`;
      return item;
    }
    if (element.kind === 'prompt') {
      const item = new vscode.TreeItem(' ' + element.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('arrow-small-right');
      item.tooltip = element.text;
      item.contextValue = 'prompt';
      item.description = `#${element.index + 1}`;
      return item;
    }
    const s = element.session;
    const title = this.displayTitle(s);
    // One line, no clutter: age once on the left, then the title gets all
    // remaining width. Session metadata and capped message excerpts live in the tooltip;
    // The session path is available through the inline copy action.
    // Single em-space padding: VS Code has no per-item indent API, and
    // sessions at the default tree indent read as siblings of the folders.
    const ageTs = s.effTs || s.lastTs;
    // A live session gets the compact Claude mascot. Inactive rows retain
    // the em-space padding: VS Code does not expose per-item indent controls.
    const live = isLiveSession(s);
    const visibleTitle = this.treeMode === 'chronological' ? truncateTitle(title) : title;
    const label = `${live ? '' : '  '}${ageTs ? `[${relativeAge(ageTs)}] ` : ''}${visibleTitle}`;
    const item = new vscode.TreeItem(
      label,
      this.config.promptChildren && s.prompts && s.prompts.length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.id = 's:' + s.id;
    item.description = this.treeMode === 'chronological' && element.group ? element.group.label : '';
    if (live) item.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'mascot-icon.png');
    item.contextValue = 'session';
    const firstTs = s.firstMessageTs || s.lastTs;
    const lastTs = s.lastMessageTs || s.lastTs;
    const count = Number.isFinite(s.messageCount) ? s.messageCount : '?';
    const tooltip = new vscode.MarkdownString();
    const appendLine = (text) => {
      tooltip.appendText(text);
      tooltip.appendMarkdown('  \n');
    };
    const excerpt = tooltipMessageExcerpt(s);
    appendLine('Last message');
    tooltip.appendMarkdown('\n');
    if (excerpt.end.length) tooltip.appendMarkdown('`START`  \n');
    for (const line of excerpt.start) {
      tooltip.appendText(line);
      tooltip.appendMarkdown('  \n');
    }
    if (excerpt.end.length) {
      tooltip.appendMarkdown('\n...  \n\n`END`  \n');
      for (const line of excerpt.end) {
        tooltip.appendText(line);
        tooltip.appendMarkdown('  \n');
      }
    }
    tooltip.appendMarkdown('\n');
    const speaker = s.lastMessageRole === 'assistant' ? this.config.agentLabel : this.config.userLabel;
    appendLine(`${speaker} · ${tooltipDate(lastTs)}`);
    tooltip.appendMarkdown('\n');
    appendLine(`Duration · ${tooltipDuration(firstTs, lastTs)}`);
    appendLine(`Messages · ${count}`);
    tooltip.appendMarkdown('\n');
    appendLine(`Session ID · ${s.id}`);
    item.tooltip = tooltip;
    // Click opens the read-only conversation viewer (POC v3 flow). Resuming
    // stays explicit — the ▶ button in the viewer or the context menu here.
    item.command = {
      command: 'claudeSessions.openConversation',
      title: 'Open in viewer',
      arguments: [element],
    };
    return item;
  }
}

function openClaudeTerminal(cwd, name, command) {
  const terminal = vscode.window.createTerminal({ name, cwd });
  terminal.show();
  terminal.sendText(command, true);
  return terminal;
}

function pathContains(parent, child) {
  if (!parent || !child) return false;
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function sessionIsInCurrentWorkspace(session) {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.some((folder) => pathContains(folder.uri.fsPath, session.cwd));
}

async function openClaudeCodePanel(sessionId) {
  if (!SESSION_ID_RE.test(sessionId || '')) {
    vscode.window.showErrorMessage('Claude Sessions: refusing to open — session id is not a valid UUID.');
    return false;
  }
  if (vscode.extensions && !vscode.extensions.getExtension('anthropic.claude-code')) {
    vscode.window.showWarningMessage('Claude Sessions: the official Claude Code extension is not installed.');
    return false;
  }
  try {
    // The official extension de-duplicates by session id and reveals an
    // already-open panel instead of creating a second one.
    await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', sessionId, undefined);
    return true;
  } catch (error) {
    vscode.window.showWarningMessage(
      `Claude Sessions: could not open the session in Claude Code — ${error.message}`
    );
    return false;
  }
}

async function openCodexPanel(sessionId) {
  if (!SESSION_ID_RE.test(sessionId || '')) {
    vscode.window.showErrorMessage('Session Viewer: refusing to open — session id is not a valid UUID.');
    return false;
  }
  if (vscode.extensions && !vscode.extensions.getExtension('openai.chatgpt')) {
    vscode.window.showWarningMessage('Session Viewer: the official Codex extension is not installed.');
    return false;
  }
  try {
    const uri = vscode.Uri.file(`/local/${sessionId}`).with({
      scheme: 'openai-codex',
      authority: 'route',
    });
    await vscode.commands.executeCommand('vscode.openWith', uri, 'chatgpt.conversationEditor');
    return true;
  } catch (error) {
    vscode.window.showWarningMessage(`Session Viewer: could not open the Codex session — ${error.message}`);
    return false;
  }
}

async function openNewClaudeCodePanel() {
  if (vscode.extensions && !vscode.extensions.getExtension('anthropic.claude-code')) {
    vscode.window.showWarningMessage('Claude Sessions: the official Claude Code extension is not installed.');
    return false;
  }
  try {
    await vscode.commands.executeCommand('claude-vscode.newConversation');
    return true;
  } catch {
    try {
      await vscode.commands.executeCommand('claude-vscode.editor.open');
      return true;
    } catch (error) {
      vscode.window.showWarningMessage(
        `Claude Sessions: could not open a new Claude Code conversation — ${error.message}`
      );
      return false;
    }
  }
}

async function openNewClaudeCodeInFolder(folderPath, panelFlagFile) {
  if (!folderPath) return false;
  try {
    if (!fs.statSync(folderPath).isDirectory()) throw new Error('not a directory');
  } catch {
    vscode.window.showErrorMessage(`Claude Sessions: folder no longer exists: ${folderPath}`);
    return false;
  }

  const currentFolders = vscode.workspace.workspaceFolders || [];
  const inCurrentWorkspace = currentFolders.some((folder) => pathContains(folder.uri.fsPath, folderPath));
  if (inCurrentWorkspace) return openNewClaudeCodePanel();

  try {
    fs.mkdirSync(path.dirname(panelFlagFile), { recursive: true });
    fs.writeFileSync(panelFlagFile, JSON.stringify({ action: 'new', folder: folderPath, ts: Date.now() }));
  } catch (error) {
    vscode.window.showErrorMessage(`Claude Sessions: could not prepare the new window — ${error.message}`);
    return false;
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folderPath), {
    forceNewWindow: true,
  });
  return true;
}

async function openSessionInClaudeCode(session, panelFlagFile) {
  if (!session || !session.cwd) {
    vscode.window.showErrorMessage('Claude Sessions: this session has no recorded working folder.');
    return false;
  }
  if (!SESSION_ID_RE.test(session.id || '')) {
    vscode.window.showErrorMessage('Claude Sessions: refusing to open — session id is not a valid UUID.');
    return false;
  }
  // Home-directory sessions are intentionally "No project" sessions. Open
  // the official conversation directly; never mount the whole home directory
  // as the Explorer workspace just to review it.
  if (session.cwd === os.homedir()) return openClaudeCodePanel(session.id);
  try {
    if (!fs.statSync(session.cwd).isDirectory()) throw new Error('not a directory');
  } catch {
    vscode.window.showErrorMessage(`Claude Sessions: session folder no longer exists: ${session.cwd}`);
    return false;
  }

  if (sessionIsInCurrentWorkspace(session)) return openClaudeCodePanel(session.id);

  try {
    fs.mkdirSync(path.dirname(panelFlagFile), { recursive: true });
    fs.writeFileSync(
      panelFlagFile,
      JSON.stringify({ action: 'resume', folder: session.cwd, sessionId: session.id, ts: Date.now() })
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Claude Sessions: could not prepare the new window — ${error.message}`);
    return false;
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(session.cwd), {
    forceNewWindow: true,
  });
  return true;
}

async function maybeShowFirstRunReviewChoice(context) {
  const key = 'welcome.reviewChoiceShown.v1';
  if (context.globalState.get(key, false)) return;
  const openReview = 'Open Review Pane';
  const treeOnly = 'Tree Only';
  const settings = 'Settings';
  const choice = await vscode.window.showInformationMessage(
    'Claude Sessions Viewer can reveal the current Claude tab in the tree and optionally open a read-only review pane. New users get the review pane by default; you can switch it off anytime.',
    openReview,
    treeOnly,
    settings
  );
  const cfg = vscode.workspace.getConfiguration('claudeSessionsViewer');
  if (choice === treeOnly) {
    await cfg.update('reveal.openConversation', false, vscode.ConfigurationTarget.Global);
  } else if (choice === openReview) {
    await cfg.update('reveal.openConversation', true, vscode.ConfigurationTarget.Global);
  } else if (choice === settings) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'claudeSessionsViewer.reveal.openConversation');
  }
  await context.globalState.update(key, true);
}

function activate(context) {
  const provider = new SessionTreeProvider(context);
  const viewer = new ConversationViewer(context);
  const panelFlagFile = path.join(context.globalStorageUri.fsPath, 'open-panel-flag.json');
  const sessionForAction = (session) => ({
    ...session.raw,
    cwd: session.cwd,
    source: session.source,
  });
  const sidebar = new SessionsWebviewProvider(context, provider, {
    open: async (session) => {
      await viewer.open(sessionForAction(session), session.title, session.folderLabel);
    },
    official: async (session) => {
      if (session.source === 'codex') return openCodexPanel(session.id);
      return openSessionInClaudeCode(sessionForAction(session), panelFlagFile);
    },
    resume: async (session) => {
      if (!SESSION_ID_RE.test(session.id)) throw new Error('refusing to resume — session id is not a valid UUID.');
      try {
        if (!fs.statSync(session.cwd).isDirectory()) throw new Error('not a directory');
      } catch {
        throw new Error(`cannot resume because the project folder no longer exists: ${session.cwd}`);
      }
      const command = session.source === 'codex'
        ? `codex resume ${session.id}`
        : `claude --resume ${session.id}`;
      openClaudeTerminal(session.cwd, `${session.source} · ${session.folderLabel}`, command);
    },
    copy: async (session) => {
      await vscode.env.clipboard.writeText(session.file);
      return 'Copied session file path';
    },
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('claudeSessions.tree', sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const revealSessionInTree = async (sessionId) => {
    const revealed = await sidebar.revealSession(sessionId);
    if (!revealed) vscode.window.showWarningMessage('Session Viewer: this session is no longer available. Refresh to scan again.');
    return revealed;
  };

  // Which indexed session does the focused editor tab show? Shared by the
  // status-bar reveal and the tab context-menu entries so all of them agree on
  // what "this session" means. Only the Claude index is touched here — the
  // Codex scan is not involved, so this stays cheap.
  // `matched` is false when nothing could be tied to the tab and we fell back
  // to the most recent session; callers decide whether to say so.
  const resolveActiveTabSession = async () => {
    await provider.refreshAndLoad();
    const all = provider.groups.flatMap((group) =>
      group.sessions.map((session) => ({ kind: 'session', session, group }))
    );
    if (!all.length) return null;
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const titleMatch = provider.findByActiveTabTitle(all, activeTab ? activeTab.label : '');
    if (titleMatch) return { node: titleMatch, matched: true };
    const now = Date.now();
    const recent = all
      .filter((n) => isLiveSession(n.session, now))
      .sort((a, b) => b.session.mtimeMs - a.session.mtimeMs);
    if (recent.length) return { node: recent[0], matched: true };
    const newest = [...all].sort((a, b) => (b.session.mtimeMs || 0) - (a.session.mtimeMs || 0))[0];
    return { node: newest, matched: false };
  };

  // Marks which entry in the toolbar dropdown is the default, so it carries a
  // checkmark and reads as "the one you get if you don't think about it".
  // 'both' = reveal in the tree AND open the messenger, the long-standing
  // behaviour of the ✳ button before it became a dropdown.
  vscode.commands.executeCommand('setContext', 'claudeSessions.defaultOpenTarget', 'both');

  // Always-available entry point: status-bar ✳ reveals the current session.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.text = '$(sparkle)';
  statusItem.tooltip = 'Reveal current Claude session in Session Viewer';
  statusItem.command = 'claudeSessions.revealCurrent';
  const updateRevealStatus = () => {
    if (vscode.workspace.getConfiguration('claudeSessionsViewer').get('reveal.enabled', true)) statusItem.show();
    else statusItem.hide();
  };
  updateRevealStatus();
  context.subscriptions.push(statusItem);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeSessionsViewer.reveal.enabled')) updateRevealStatus();
      if (e.affectsConfiguration('claudeSessionsViewer.promptChildren.enabled')) sidebar.refresh();
      if (e.affectsConfiguration('claudeSessionsViewer.showAutomationSessions')) sidebar.refresh();
      if (e.affectsConfiguration('claudeSessionsViewer.timeline.enabled')) {
        if (!provider.config.timelineEnabled && provider.treeMode === 'chronological') {
          provider.treeMode = 'folders';
          context.globalState.update('treeMode', 'folders');
        }
        provider.updateModeUi();
        sidebar.refresh();
      }
    })
  );
  setTimeout(() => {
    maybeShowFirstRunReviewChoice(context).catch(() => {});
  }, 1200);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessions.refresh', () => sidebar.refresh()),

    vscode.commands.registerCommand('claudeSessions.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:yurykoretskiy.claude-sessions-viewer')
    ),

    vscode.commands.registerCommand('claudeSessions.revealViewerSession', (sessionId) =>
      revealSessionInTree(String(sessionId || ''))
    ),

    vscode.commands.registerCommand('claudeSessions.openViewerInClaudeCode', (session) =>
      session && session.source === 'codex'
        ? openCodexPanel(session.id)
        : openSessionInClaudeCode(session, panelFlagFile)
    ),

    vscode.commands.registerCommand('claudeSessions.expandAll', () => provider.setExpandedAll(true)),
    vscode.commands.registerCommand('claudeSessions.collapseAll', () => provider.setExpandedAll(false)),

    vscode.commands.registerCommand('claudeSessions.toggleGrouping', () => provider.toggleGrouping()),
    vscode.commands.registerCommand('claudeSessions.toggleGroupingAlt', () => provider.toggleGrouping()),

    vscode.commands.registerCommand('claudeSessions.newWindowHere', async (arg) => {
      let folderPath = null;
      if (arg && arg.fsPath) folderPath = arg.fsPath;
      else if (arg && arg.kind === 'folder') folderPath = arg.group.folderPath;
      if (!folderPath) return;
      // Leave a note for the extension instance in the new window: it should
      // open the Claude panel once that window (rooted at folderPath) starts.
      try {
        fs.mkdirSync(path.dirname(panelFlagFile), { recursive: true });
        fs.writeFileSync(panelFlagFile, JSON.stringify({ folder: folderPath, ts: Date.now() }));
      } catch {}
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folderPath), {
        forceNewWindow: true,
      });
    }),

    vscode.commands.registerCommand('claudeSessions.newClaudeCodeHere', async (arg) => {
      let folderPath = null;
      if (arg && arg.fsPath) folderPath = arg.fsPath;
      else if (arg && arg.kind === 'folder') folderPath = arg.group.folderPath;
      else if (provider.workspaceRoot) folderPath = provider.workspaceRoot;
      await openNewClaudeCodeInFolder(folderPath, panelFlagFile);
    }),

    vscode.commands.registerCommand('claudeSessions.newHere', (arg) => {
      let folderPath = null;
      if (arg && arg.fsPath) folderPath = arg.fsPath; // explorer context menu (Uri)
      else if (arg && arg.kind === 'folder') folderPath = arg.group.folderPath; // tree node
      else if (provider.workspaceRoot) folderPath = provider.workspaceRoot;
      if (!folderPath) return;
      openClaudeTerminal(folderPath, `claude · ${path.basename(folderPath)}`, 'claude');
    }),

    vscode.commands.registerCommand('claudeSessions.resume', (node) => {
      const s = node.session;
      // The id becomes part of a shell command; only ever pass a strict UUID
      // through (ids come from filenames, which an attacker could craft in a
      // shared session pack).
      if (!SESSION_ID_RE.test(s.id)) {
        vscode.window.showErrorMessage('Claude Sessions: refusing to resume — session id is not a valid UUID.');
        return;
      }
      // Resume must run from the session's original cwd so `claude --resume` finds it.
      openClaudeTerminal(s.cwd, `claude · ${node.group.label}`, `claude --resume ${s.id}`);
    }),

    vscode.commands.registerCommand('claudeSessions.openInClaudeCode', async (node) => {
      if (!node || node.kind !== 'session') return;
      provider.rememberSession(node);
      await openSessionInClaudeCode(node.session, panelFlagFile);
    }),

    // Timeline row -> jump to the session's place in the folder tree.
    vscode.commands.registerCommand('claudeSessions.showInFolders', async (node) => {
      if (!node || node.kind !== 'session') return;
      await revealSessionInTree(node.session.id);
    }),

    vscode.commands.registerCommand('claudeSessions.revealCurrent', async () => {
      if (!provider.config.revealEnabled) {
        vscode.window.showInformationMessage('Claude Sessions: reveal is switched off in settings');
        return;
      }
      // "Current session" = the transcript being actively written (newest
      // mtime). Fresh index first so mtimes are current.
      const resolved = await resolveActiveTabSession();
      if (!resolved) {
        vscode.window.showInformationMessage('Claude Sessions: no sessions found');
        return;
      }
      if (!resolved.matched) {
        vscode.window.showInformationMessage(
          'Claude Sessions: no session active in the last 5 minutes — revealing the most recent one'
        );
      }
      const node = resolved.node;
      await sidebar.revealSession(node.session.id, 'claude');
      provider.rememberSession(node);
      if (provider.config.revealOpenConversation) {
        await viewer.open({ ...node.session, source: 'claude' }, provider.displayTitle(node.session), node.group.label, {
          beside: true,
        });
      }
    }),

    // Tab context menu — "open this session in the messenger": the read-only
    // conversation panel, beside the tab you right-clicked.
    vscode.commands.registerCommand('claudeSessions.openTabInMessenger', async () => {
      const resolved = await resolveActiveTabSession();
      if (!resolved) {
        vscode.window.showInformationMessage('Session Viewer: no sessions found');
        return;
      }
      const node = resolved.node;
      provider.rememberSession(node);
      await viewer.open(
        { ...node.session, source: 'claude' },
        provider.displayTitle(node.session),
        node.group.label,
        { beside: true }
      );
    }),

    // Tab context menu — "open this session in the preview": select it in the
    // Session Viewer sidebar instead of opening a panel.
    vscode.commands.registerCommand('claudeSessions.openTabInPreview', async () => {
      const resolved = await resolveActiveTabSession();
      if (!resolved) {
        vscode.window.showInformationMessage('Session Viewer: no sessions found');
        return;
      }
      provider.rememberSession(resolved.node);
      await revealSessionInTree(resolved.node.session.id);
    }),

    // Session-row context menu (webview/context) — same two choices, but
    // targeting the exact row that was right-clicked instead of the active
    // tab. `ctx` is the row's data-vscode-context payload: { key, cwd }.
    vscode.commands.registerCommand('claudeSessions.openRowInMessenger', async (ctx) => {
      const session = sidebar.resolveSession(ctx && ctx.key, ctx && ctx.cwd);
      if (!session) return;
      await sidebar.handlers.open(session);
    }),

    vscode.commands.registerCommand('claudeSessions.openRowInPreview', async (ctx) => {
      const session = sidebar.resolveSession(ctx && ctx.key, ctx && ctx.cwd);
      if (!session) return;
      await revealSessionInTree(session.id);
    }),

    vscode.commands.registerCommand('claudeSessions.openConversation', async (node) => {
      try {
        provider.rememberSession(node);
        await viewer.open(node.session, provider.displayTitle(node.session), node.group.label);
      } catch (e) {
        vscode.window.showErrorMessage(`Claude Sessions: could not open conversation — ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('claudeSessions.copySessionPath', (node) => {
      vscode.env.clipboard.writeText(node.session.file);
      vscode.window.showInformationMessage(`Copied session path ${node.session.file}`);
    })
  );

  // Consume a cross-window request only in the window rooted at its folder.
  // A resume request carries the exact historical session id; a legacy/new
  // request starts a fresh official Claude Code conversation.
  try {
    const flag = JSON.parse(fs.readFileSync(panelFlagFile, 'utf8'));
    if (flag.folder === provider.workspaceRoot && Date.now() - flag.ts < 120000) {
      fs.unlinkSync(panelFlagFile);
      setTimeout(async () => {
        if (flag.action === 'resume' && SESSION_ID_RE.test(flag.sessionId || '')) {
          await openClaudeCodePanel(flag.sessionId);
          return;
        }
        try {
          await vscode.commands.executeCommand('claude-vscode.newConversation');
        } catch {
          try {
            await vscode.commands.executeCommand('claude-vscode.editor.open');
          } catch {
            vscode.window.showWarningMessage(
              'Claude Sessions: could not open the Claude Code panel (is the Claude Code extension installed?)'
            );
          }
        }
      }, 1500);
    } else if (Date.now() - flag.ts >= 120000) {
      fs.unlinkSync(panelFlagFile);
    }
  } catch {}

}

function deactivate() {}

// Provider and launch helpers are exported for the test suite only.
module.exports = {
  activate,
  deactivate,
  SessionTreeProvider,
  pathContains,
  openClaudeCodePanel,
  openCodexPanel,
  openNewClaudeCodePanel,
  openNewClaudeCodeInFolder,
  openSessionInClaudeCode,
};
