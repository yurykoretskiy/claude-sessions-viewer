const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../package.json');

test('main sessions surface is a webview with no native tree toolbars or row menus', () => {
  const view = manifest.contributes.views.claudeSessions[0];
  assert.strictEqual(view.id, 'claudeSessions.tree');
  assert.strictEqual(view.type, 'webview');
  assert.strictEqual(manifest.contributes.menus['view/title'], undefined);
  assert.strictEqual(manifest.contributes.menus['view/item/context'], undefined);
});

test('Explorer folders retain modular Claude Code and terminal actions', () => {
  const folderActions = manifest.contributes.menus['explorer/context']
    .sort((a, b) => a.group.localeCompare(b.group));

  assert.deepStrictEqual(folderActions.map((item) => item.command), [
    'claudeSessions.newClaudeCodeHere',
    'claudeSessions.newHere',
  ]);
  assert.ok(folderActions[0].when.includes('folderActions.claudeCode.enabled'));
  assert.ok(folderActions[1].when.includes('folderActions.terminal.enabled'));

  const commands = manifest.contributes.commands;
  const claudeAction = commands.find((item) => item.command === 'claudeSessions.newClaudeCodeHere');
  const terminalAction = commands.find((item) => item.command === 'claudeSessions.newHere');
  assert.deepStrictEqual(claudeAction.icon, commands.find((item) => item.command === 'claudeSessions.openInClaudeCode').icon);
  assert.deepStrictEqual(terminalAction.icon, commands.find((item) => item.command === 'claudeSessions.resume').icon);

  const treeSettings = manifest.contributes.configuration.find((group) => group.title === 'Session Viewer Sources').properties;
  assert.strictEqual(treeSettings['claudeSessionsViewer.folderActions.claudeCode.enabled'].default, true);
  assert.strictEqual(treeSettings['claudeSessionsViewer.folderActions.terminal.enabled'].default, true);
});

test('tree action glyphs use padded local assets so the current shapes read lighter', () => {
  const commands = manifest.contributes.commands;
  for (const commandId of [
    'claudeSessions.openConversation',
    'claudeSessions.resume',
    'claudeSessions.copySessionPath',
  ]) {
    const command = commands.find((item) => item.command === commandId);
    assert.match(command.icon.light, /^assets\/tree-/);
    assert.match(command.icon.dark, /^assets\/tree-/);
  }
});

test('the prominent mascot is limited to the Activity Bar and reveal action', () => {
  assert.strictEqual(manifest.contributes.viewsContainers.activitybar[0].icon, 'assets/mascot-prominent.png');
  const reveal = manifest.contributes.commands.find((item) => item.command === 'claudeSessions.revealCurrent');
  assert.strictEqual(reveal.icon.light, 'assets/mascot-prominent.png');
  assert.strictEqual(reveal.icon.dark, 'assets/mascot-prominent.png');
});

test('Claude Code action uses the official Claude logo asset', () => {
  const command = manifest.contributes.commands.find(
    (item) => item.command === 'claudeSessions.openInClaudeCode'
  );
  assert.deepStrictEqual(command.icon, {
    light: 'assets/claude-code-logo-light.svg',
    dark: 'assets/claude-code-logo-dark.svg',
  });
  const lightLogo = fs.readFileSync(path.join(__dirname, '..', command.icon.light), 'utf8');
  const darkLogo = fs.readFileSync(path.join(__dirname, '..', command.icon.dark), 'utf8');
  assert.match(lightLogo, /fill="#424242"/);
  assert.match(darkLogo, /fill="#c5c5c5"/);
  assert.match(lightLogo, /viewBox="-3 -3 30 30"/);
  assert.match(darkLogo, /viewBox="-3 -3 30 30"/);
  assert.doesNotMatch(lightLogo, /#D97757|currentColor/i);
  assert.doesNotMatch(darkLogo, /#D97757|currentColor/i);
});

test('global search is preserved in source but not activated in the main extension', () => {
  const viewIds = manifest.contributes.views.claudeSessions.map((view) => view.id);
  const commandIds = manifest.contributes.commands.map((command) => command.command);

  assert.deepStrictEqual(viewIds, ['claudeSessions.tree']);
  assert.ok(!commandIds.includes('claudeSessions.searchAll'));
});

test('speaker labels are global settings and the viewer has no naming toggle', () => {
  const groups = manifest.contributes.configuration;
  const viewer = groups.find((group) => group.order === 2);
  assert.strictEqual(viewer.properties['claudeSessionsViewer.userLabel'].default, 'USER');
  assert.strictEqual(viewer.properties['claudeSessionsViewer.agentLabel'].default, 'CLAUDE');
  assert.ok(!viewer.properties['claudeSessionsViewer.showNames']);
});
