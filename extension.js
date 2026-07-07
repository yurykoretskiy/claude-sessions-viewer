const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { indexAll } = require('./indexer');
const { ConversationViewer } = require('./viewer');

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
    this.groups = []; // [{ id, label, folderPath, sessions: [...] }]
    this.loaded = false;
    this.loading = null;
    this.expandedAll = false;
    this.expansionRevision = 0;
    this.selectedSessionId = context.globalState.get('selectedSessionId', null);
    // 'folders' = one folder row, A-Z, with all sessions inside.
    // 'chronological' = newest sessions first, wrapped in folder rows; a folder
    // can appear more than once when its sessions are separated by time.
    this.treeMode = context.globalState.get('treeMode', 'folders');
  }

  async toggleGrouping() {
    const sessionId = this.selectedSessionId;
    if (sessionId) this.context.globalState.update('selectedSessionId', sessionId);
    this.treeMode = this.treeMode === 'folders' ? 'chronological' : 'folders';
    this.context.globalState.update('treeMode', this.treeMode);
    this.updateModeUi();
    vscode.window.setStatusBarMessage(
      this.treeMode === 'folders'
        ? 'Claude Sessions: folders A-Z.'
        : 'Claude Sessions: newest sessions first.',
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
      const mode = this.treeMode === 'folders' ? 'folders A-Z' : 'chronological';
      this.view.description = this.loaded ? mode : `${mode} · indexing`;
    }
    vscode.commands.executeCommand('setContext', 'claudeSessions.mode', this.treeMode);
    vscode.commands.executeCommand('setContext', 'claudeSessions.expandedAll', this.expandedAll);
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
      revealEnabled: c.get('reveal.enabled', true),
      revealOpenConversation: c.get('reveal.openConversation', true),
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
      g.sessions.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
      g.latest = g.sessions[0] ? g.sessions[0].lastTs || '' : '';
    }
    groups.sort((a, b) => a.label.localeCompare(b.label) || a.folderPath.localeCompare(b.folderPath));
    markLabelCollisions(groups);
    return groups;
  }

  buildChronologicalGroups(sessions, root) {
    const entries = [];
    for (const s of sessions) {
      const attr = this.folderForSession(s, root);
      if (attr) entries.push({ session: s, folder: attr });
    }
    entries.sort((a, b) => (b.session.lastTs || '').localeCompare(a.session.lastTs || ''));
    const groups = [];
    for (const entry of entries) {
      const prev = groups[groups.length - 1];
      if (prev && prev.folderPath === entry.folder.folderPath) {
        prev.sessions.push(entry.session);
        continue;
      }
      groups.push({
        id: `t:${entry.folder.folderPath}:${entry.session.id}`,
        label: entry.folder.label,
        folderPath: entry.folder.folderPath,
        latest: entry.session.lastTs || '',
        sessions: [entry.session],
      });
    }
    markLabelCollisions(groups);
    return groups;
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
          const sessions = [...byId.values()];
          const root = this.workspaceRoot;
          this.groups =
            this.treeMode === 'chronological'
              ? this.buildChronologicalGroups(sessions, root)
              : this.buildFolderGroups(sessions, root);
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

  async rename(node) {
    const s = node.session;
    const titles = { ...this.context.globalState.get('customTitles', {}) };
    const value = await vscode.window.showInputBox({
      prompt: 'Custom session title (leave empty to restore the original)',
      value: titles[s.id] || s.title || '',
    });
    if (value === undefined) return; // cancelled
    if (value.trim()) titles[s.id] = value.trim();
    else delete titles[s.id];
    await this.context.globalState.update('customTitles', titles);
    this._onDidChangeTreeData.fire();
  }

  allSessions() {
    return this.groups.flatMap((g) => g.sessions.map((s) => ({ kind: 'session', session: s, group: g })));
  }

  getParent(element) {
    if (element.kind === 'session') return { kind: 'folder', group: element.group };
    if (element.kind === 'prompt' && element.parent) return element.parent;
    return null;
  }

  async getChildren(element) {
    if (!this.loaded) {
      this.ensureLoaded().catch(() => {});
      if (!element) return this.groups.length ? this.groups.map((g) => ({ kind: 'folder', group: g })) : [this.loadingNode()];
      return [];
    }
    if (!element) {
      return this.groups.map((g) => ({ kind: 'folder', group: g }));
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
      const label =
        this.treeMode === 'chronological' && g.latest
          ? `${g.label} [${relativeAge(g.latest)}]`
          : g.label;
      const item = new vscode.TreeItem(
        label,
        this.expandedAll ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
      );
      // VS Code preserves expansion state by TreeItem.id. Include a small
      // revision so the explicit expand/collapse toolbar button can override
      // the user's previous manual expansion state.
      item.id = `${g.id}:${this.expansionRevision}:${this.expandedAll ? 'open' : 'closed'}`;
      let exists = true;
      try {
        exists = fs.statSync(g.folderPath).isDirectory();
      } catch {
        exists = false;
      }
      // Two projects can share a folder basename; disambiguate only the
      // colliding groups with their shortened parent path.
      const parentHint = g.labelCollision ? shortHome(path.dirname(g.folderPath)) : '';
      const countPart =
        this.treeMode === 'chronological' ? '' : `${g.sessions.length}`;
      const statusPart = exists ? '' : 'gone';
      item.description = [parentHint, countPart, statusPart].filter(Boolean).join(' · ');
      item.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'folder-spark.svg');
      item.contextValue = 'folder';
      item.tooltip = exists
        ? g.folderPath
        : `${g.folderPath}\n\nThis folder no longer exists on disk — the sessions recorded here are kept as history.`;
      return item;
    }
    if (element.kind === 'prompt') {
      const item = new vscode.TreeItem('  ' + element.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('arrow-small-right');
      item.tooltip = element.text;
      item.contextValue = 'prompt';
      item.description = `#${element.index + 1}`;
      return item;
    }
    const s = element.session;
    const title = this.displayTitle(s);
    const label =
      this.treeMode === 'chronological' && s.lastTs
        ? `  [${relativeAge(s.lastTs)}] ${title}`
        : '  ' + title;
    // Em-space padding: VS Code has no per-item indent API, and sessions at
    // the default tree indent read as siblings of the folders.
    const item = new vscode.TreeItem(
      label,
      this.config.promptChildren && s.prompts && s.prompts.length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.id = 's:' + s.id;
    const live = s.mtimeMs && Date.now() - s.mtimeMs < 5 * 60 * 1000 ? '● ' : '';
    item.description = `${live}${s.id.slice(0, 8)} · ${relativeAge(s.lastTs)}`;
    // No icon on session rows — the space goes to the session title instead.
    item.contextValue = 'session';
    item.tooltip = new vscode.MarkdownString(
      [
        `**${title}**`,
        '',
        `id: \`${s.id}\``,
        `started in: \`${shortHome(s.cwd || '?')}\``,
        s.lastPrompt ? `last prompt: ${s.lastPrompt.slice(0, 200)}` : '',
      ].join('\n')
    );
    // Click opens the read-only conversation viewer (POC v3 flow). Resuming
    // stays explicit — the ▶ button in the viewer or the context menu here.
    item.command = {
      command: 'claudeSessions.openConversation',
      title: 'Open as conversation',
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
  const view = vscode.window.createTreeView('claudeSessions.tree', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(view);
  provider.view = view;
  provider.updateModeUi();
  context.subscriptions.push(
    view.onDidChangeSelection((e) => {
      const node = e.selection && e.selection[0];
      provider.setSelectionInMemory(node);
    })
  );

  const viewer = new ConversationViewer(context);
  const panelFlagFile = path.join(context.globalStorageUri.fsPath, 'open-panel-flag.json');

  // Always-available entry point: status-bar ✳ reveals the current session.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.text = '$(sparkle)';
  statusItem.tooltip = 'Reveal current Claude session in the tree';
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
      if (e.affectsConfiguration('claudeSessionsViewer.promptChildren.enabled')) provider.refresh();
    })
  );
  setTimeout(() => {
    maybeShowFirstRunReviewChoice(context).catch(() => {});
  }, 1200);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessions.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('claudeSessions.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:yurykoretskiy.claude-sessions-viewer')
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
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.id)) {
        vscode.window.showErrorMessage('Claude Sessions: refusing to resume — session id is not a valid UUID.');
        return;
      }
      // Resume must run from the session's original cwd so `claude --resume` finds it.
      openClaudeTerminal(s.cwd, `claude · ${node.group.label}`, `claude --resume ${s.id}`);
    }),

    vscode.commands.registerCommand('claudeSessions.rename', (node) => provider.rename(node)),

    vscode.commands.registerCommand('claudeSessions.revealCurrent', async () => {
      if (!provider.config.revealEnabled) {
        vscode.window.showInformationMessage('Claude Sessions: reveal is switched off in settings');
        return;
      }
      // "Current session" = the transcript being actively written (newest
      // mtime). Fresh index first so mtimes are current.
      await provider.refreshAndLoad();
      const all = provider.allSessions();
      if (!all.length) {
        vscode.window.showInformationMessage('Claude Sessions: no sessions found');
        return;
      }
      const activeTabTitle = vscode.window.tabGroups.activeTabGroup.activeTab
        ? vscode.window.tabGroups.activeTabGroup.activeTab.label
        : '';
      const titleMatch = provider.findByActiveTabTitle(all, activeTabTitle);
      const now = Date.now();
      const recent = all
        .filter((n) => n.session.mtimeMs && now - n.session.mtimeMs < 5 * 60 * 1000)
        .sort((a, b) => b.session.mtimeMs - a.session.mtimeMs);
      let node;
      if (titleMatch) {
        node = titleMatch;
      } else if (recent.length) {
        node = recent[0];
      } else {
        node = all.sort((a, b) => (b.session.mtimeMs || 0) - (a.session.mtimeMs || 0))[0];
        vscode.window.showInformationMessage(
          'Claude Sessions: no session active in the last 5 minutes — revealing the most recent one'
        );
      }
      try {
        await vscode.commands.executeCommand('workbench.view.extension.claudeSessions');
        await view.reveal(node, { select: true, expand: true, focus: false });
        provider.rememberSession(node);
      } catch (e) {
        vscode.window.showWarningMessage('Claude Sessions: could not reveal — ' + e.message);
      }
      if (provider.config.revealOpenConversation) {
        await viewer.open(node.session, provider.displayTitle(node.session), node.group.label, {
          beside: true,
        });
      }
    }),

    vscode.commands.registerCommand('claudeSessions.openConversation', async (node) => {
      try {
        provider.rememberSession(node);
        await viewer.open(node.session, provider.displayTitle(node.session), node.group.label);
      } catch (e) {
        vscode.window.showErrorMessage(`Claude Sessions: could not open conversation — ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('claudeSessions.openTranscript', (node) => {
      vscode.window.showTextDocument(vscode.Uri.file(node.session.file));
    }),

    vscode.commands.registerCommand('claudeSessions.copySessionId', (node) => {
      vscode.env.clipboard.writeText(node.session.id);
      vscode.window.showInformationMessage(`Copied session id ${node.session.id}`);
    })
  );

  // If a "new window session here" note was left for this window, consume it
  // and open the Claude panel (this window is rooted at the requested folder,
  // so the official extension attaches its session there).
  try {
    const flag = JSON.parse(fs.readFileSync(panelFlagFile, 'utf8'));
    if (flag.folder === provider.workspaceRoot && Date.now() - flag.ts < 120000) {
      fs.unlinkSync(panelFlagFile);
      setTimeout(async () => {
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

  // Refresh on demand only — when the panel becomes visible — rather than
  // watching the filesystem on a timer. This keeps the tree order stable while
  // you browse (no rows jumping as sessions write); the grouping and the
  // newest→oldest-within-folder order are untouched. Locating a session and
  // opening it still reads its transcript fresh from disk (see viewer.js), and
  // the reveal command re-indexes before it locates the current session.
  context.subscriptions.push(
    view.onDidChangeVisibility((e) => {
      if (e.visible) provider.refresh();
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
