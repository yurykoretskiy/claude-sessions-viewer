const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { indexAll, PROJECTS_DIR } = require('./indexer');

const MIN_MENTIONS = 3; // content-attribution threshold for root-started sessions
const IGNORED_SEGMENTS = new Set(['node_modules', 'venv', '__pycache__', 'dist', 'build']);

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

class SessionTreeProvider {
  constructor(context) {
    this.context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.groups = []; // [{ label, folderPath, kind, sessions: [...] }]
    this.loaded = false;
    this.loading = null;
    // 'smart' = attribute root sessions by transcript content;
    // 'raw' = mirror Claude's own index (group by ~/.claude/projects dir).
    this.groupMode = context.globalState.get('groupMode', 'smart');
  }

  toggleGrouping() {
    this.groupMode = this.groupMode === 'smart' ? 'raw' : 'smart';
    this.context.globalState.update('groupMode', this.groupMode);
    this.updateModeUi();
    this.refresh();
  }

  // Persistent mode indicator: text next to the view title + which title
  // button (list-tree vs list-flat icon) is shown via the context key.
  updateModeUi() {
    if (this.view) {
      this.view.description = this.groupMode === 'smart' ? 'smart grouping' : 'raw Claude index';
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

  refresh() {
    this.loaded = false;
    this.loading = null;
    this._onDidChangeTreeData.fire();
  }

  attributeSession(s, root) {
    // Returns { folderPath, label, byContent }
    if (!s.cwd) return null;
    if (root && s.cwd === root) {
      let best = null;
      let bestCount = 0;
      for (const [seg, count] of Object.entries(s.folderMentions || {})) {
        if (seg.startsWith('.') || IGNORED_SEGMENTS.has(seg)) continue;
        if (count < MIN_MENTIONS || count <= bestCount) continue;
        const p = path.join(root, seg);
        try {
          if (!fs.statSync(p).isDirectory()) continue;
        } catch {
          continue;
        }
        best = seg;
        bestCount = count;
      }
      if (best) {
        return { folderPath: path.join(root, best), label: best, byContent: true };
      }
      return { folderPath: root, label: 'root (unassigned)', byContent: false };
    }
    if (root && s.cwd.startsWith(root + path.sep)) {
      const seg = s.cwd.slice(root.length + 1).split(path.sep)[0];
      return { folderPath: path.join(root, seg), label: seg, byContent: false };
    }
    return { folderPath: s.cwd, label: shortHome(s.cwd), byContent: false };
  }

  async ensureLoaded() {
    if (this.loaded) return;
    if (!this.loading) {
      this.loading = vscode.window.withProgress(
        { location: { viewId: 'claudeSessions.tree' }, title: 'Indexing Claude sessions…' },
        async () => {
          const sessions = await indexAll(this.cacheFile);
          const root = this.workspaceRoot;
          const map = new Map();
          for (const s of sessions) {
            const attr =
              this.groupMode === 'raw'
                ? s.cwd
                  ? { folderPath: s.cwd, label: shortHome(s.cwd), byContent: false }
                  : null
                : this.attributeSession(s, root);
            if (!attr) continue;
            const key = attr.folderPath + '::' + attr.label;
            if (!map.has(key)) {
              map.set(key, { label: attr.label, folderPath: attr.folderPath, sessions: [] });
            }
            map.get(key).sessions.push({ ...s, byContent: attr.byContent });
          }
          this.groups = [...map.values()];
          for (const g of this.groups) {
            g.sessions.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
            g.latest = g.sessions[0] ? g.sessions[0].lastTs || '' : '';
          }
          this.groups.sort((a, b) => b.latest.localeCompare(a.latest));
          this.loaded = true;
          this._onDidChangeTreeData.fire();
        }
      );
    }
    await this.loading;
  }

  async getChildren(element) {
    await this.ensureLoaded();
    if (!element) {
      return this.groups.map((g) => ({ kind: 'folder', group: g }));
    }
    if (element.kind === 'folder') {
      return element.group.sessions.map((s) => ({ kind: 'session', session: s, group: element.group }));
    }
    return [];
  }

  getTreeItem(element) {
    if (element.kind === 'folder') {
      const g = element.group;
      const item = new vscode.TreeItem(g.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${g.sessions.length}`;
      item.iconPath = new vscode.ThemeIcon(g.label === 'root (unassigned)' ? 'inbox' : 'folder');
      item.contextValue = 'folder';
      item.tooltip = g.folderPath;
      return item;
    }
    const s = element.session;
    const title = s.title || s.firstPrompt || s.lastPrompt || s.id.slice(0, 8);
    const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
    item.description = `${s.id.slice(0, 8)} · ${relativeAge(s.lastTs)}${s.byContent ? ' ≈' : ''}`;
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    item.contextValue = 'session';
    item.tooltip = new vscode.MarkdownString(
      [
        `**${title}**`,
        '',
        `id: \`${s.id}\``,
        `started in: \`${shortHome(s.cwd || '?')}\``,
        s.byContent ? '_attributed by content (session started at workspace root)_' : '',
        s.lastPrompt ? `last prompt: ${s.lastPrompt.slice(0, 200)}` : '',
      ].join('\n')
    );
    item.command = {
      command: 'claudeSessions.resume',
      title: 'Resume',
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

function activate(context) {
  const provider = new SessionTreeProvider(context);
  const view = vscode.window.createTreeView('claudeSessions.tree', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);
  provider.view = view;
  provider.updateModeUi();

  const panelFlagFile = path.join(context.globalStorageUri.fsPath, 'open-panel-flag.json');

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessions.refresh', () => provider.refresh()),

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

  // Auto-refresh when session files change (debounced).
  try {
    let timer = null;
    const watcher = fs.watch(PROJECTS_DIR, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => provider.refresh(), 5000);
    });
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch {}
}

function deactivate() {}

module.exports = { activate, deactivate };
