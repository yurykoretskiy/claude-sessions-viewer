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
    this.groups = []; // [{ label, folderPath, kind, sessions: [...] }]
    this.loaded = false;
    this.loading = null;
    // 'smart' = group by the real working folder recorded in the transcript;
    // 'raw' = group by Claude's recorded cwd without workspace-relative folding.
    this.groupMode = context.globalState.get('groupMode', 'smart');
  }

  toggleGrouping() {
    this.groupMode = this.groupMode === 'smart' ? 'raw' : 'smart';
    this.context.globalState.update('groupMode', this.groupMode);
    this.updateModeUi();
    vscode.window.setStatusBarMessage(
      this.groupMode === 'smart'
        ? 'Claude Sessions: grouped by real working folder.'
        : 'Claude Sessions: grouped by Claude raw storage/cwd.',
      3500
    );
    this.refresh();
  }

  // Persistent mode indicator: text next to the view title + which title
  // button (list-tree vs list-flat icon) is shown via the context key.
  updateModeUi() {
    if (this.view) {
      const mode = this.groupMode === 'smart' ? 'working folders' : 'Claude raw storage';
      this.view.description = this.loaded ? mode : `${mode} · indexing`;
    }
    vscode.commands.executeCommand('setContext', 'claudeSessions.mode', this.groupMode);
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

  loadingNode() {
    return { kind: 'loading' };
  }

  attributeSession(s, root) {
    // Returns { folderPath, label }. The transcript cwd is ground truth; do
    // not re-file root sessions based on path mentions inside the conversation.
    if (!s.cwd) return null;
    if (root && s.cwd === root) {
      return { folderPath: root, label: path.basename(root) || shortHome(root) };
    }
    if (root && s.cwd.startsWith(root + path.sep)) {
      const seg = s.cwd.slice(root.length + 1).split(path.sep)[0];
      return { folderPath: path.join(root, seg), label: seg };
    }
    return { folderPath: s.cwd, label: shortHome(s.cwd) };
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
          const map = new Map();
          for (const s of sessions) {
            const attr =
              this.groupMode === 'raw'
                ? s.cwd
                  ? { folderPath: s.cwd, label: shortHome(s.cwd) }
                  : null
                : this.attributeSession(s, root);
            if (!attr) continue;
            const key = attr.folderPath + '::' + attr.label;
            if (!map.has(key)) {
              map.set(key, { label: attr.label, folderPath: attr.folderPath, sessions: [] });
            }
            map.get(key).sessions.push(s);
          }
          this.groups = [...map.values()];
          for (const g of this.groups) {
            g.sessions.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
            g.latest = g.sessions[0] ? g.sessions[0].lastTs || '' : '';
          }
          this.groups.sort((a, b) => b.latest.localeCompare(a.latest));
          // The project you have open always sits on top — reveal and
          // orientation start there; everything else stays recency-ordered.
          if (root) {
            const i = this.groups.findIndex((g) => g.folderPath === root);
            if (i > 0) this.groups.unshift(this.groups.splice(i, 1)[0]);
          }
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
      const item = new vscode.TreeItem(g.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'f:' + g.folderPath + ':' + g.label;
      const root = this.workspaceRoot;
      // One folder icon for everyone; the only special mark is the project
      // you have open. A dashed "outside the workspace" icon marked ~95% of
      // groups in a cross-project tree — noise, not signal.
      const icon = root && g.folderPath === root ? 'folder-root.svg' : 'folder-spark.svg';
      let exists = true;
      try {
        exists = fs.statSync(g.folderPath).isDirectory();
      } catch {
        exists = false;
      }
      item.description = exists ? `${g.sessions.length}` : `${g.sessions.length} · gone`;
      item.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'assets', icon);
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
    // Em-space padding: VS Code has no per-item indent API, and sessions at
    // the default tree indent read as siblings of the folders.
    const item = new vscode.TreeItem(
      '  ' + title,
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
    showCollapseAll: true,
  });
  context.subscriptions.push(view);
  provider.view = view;
  provider.updateModeUi();

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
      provider.refresh();
      await provider.ensureLoaded();
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
        await view.reveal(node, { select: true, expand: false, focus: false });
      } catch {}
      if (provider.config.revealOpenConversation) {
        await viewer.open(node.session, provider.displayTitle(node.session), node.group.label, {
          beside: true,
        });
      }
    }),

    vscode.commands.registerCommand('claudeSessions.openConversation', async (node) => {
      try {
        await viewer.open(node.session, provider.displayTitle(node.session), node.group.label);
      } catch (e) {
        vscode.window.showErrorMessage(`Claude Sessions: could not open conversation — ${e.message}`);
      }
    }),

    vscode.commands.registerCommand('claudeSessions.search', async () => {
      await provider.ensureLoaded();
      const items = provider.allSessions().map((n) => ({
        label: `$(comment-discussion) ${provider.displayTitle(n.session)}`,
        description: `${n.group.label} · ${n.session.id.slice(0, 8)} · ${relativeAge(n.session.lastTs)}`,
        detail: n.session.firstPrompt || n.session.lastPrompt || '',
        node: n,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Search sessions by title, prompt, folder, or id — Enter opens review',
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (pick) {
        await viewer.open(pick.node.session, provider.displayTitle(pick.node.session), pick.node.group.label);
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
