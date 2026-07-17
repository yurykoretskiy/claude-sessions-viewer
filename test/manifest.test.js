const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../package.json');

test('tree exposes exactly four explicit session-row actions', () => {
  const sessionActions = manifest.contributes.menus['view/item/context']
    .filter((item) => item.when.includes('viewItem == session') && String(item.group).startsWith('inline'))
    .sort((a, b) => a.group.localeCompare(b.group))
    .map((item) => item.command);

  assert.deepStrictEqual(sessionActions, [
    'claudeSessions.openConversation',
    'claudeSessions.openInClaudeCode',
    'claudeSessions.resume',
    'claudeSessions.copySessionPath',
  ]);
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
  assert.doesNotMatch(lightLogo, /#D97757|currentColor/i);
  assert.doesNotMatch(darkLogo, /#D97757|currentColor/i);
});

test('global search is preserved in source but not activated in the main extension', () => {
  const viewIds = manifest.contributes.views.claudeSessions.map((view) => view.id);
  const commandIds = manifest.contributes.commands.map((command) => command.command);

  assert.deepStrictEqual(viewIds, ['claudeSessions.tree']);
  assert.ok(!commandIds.includes('claudeSessions.searchAll'));
});
