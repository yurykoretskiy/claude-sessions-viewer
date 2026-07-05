# Backlog

Parked by Yury on 05 Jul 2026 — not planned, revisit on demand.

- **Rich reading experience** (from hiztam.codex-history-viewer): rendered
  chat viewer with markdown + file diffs, tags/notes on sessions, saved
  searches, "which sessions touched this file" history, import/export.
  Decision: don't port — months of UI. If rich reading is needed, install
  `hiztam.codex-history-viewer` alongside this extension, or use the
  `claude-code-viewer` web UI skill.
- **Ghost sessions**: grayed-out tree entries reconstructed from
  `~/.claude/history.jsonl` for sessions whose transcripts were auto-cleaned
  before `cleanupPeriodDays: 365` was set (05 Jul 2026). Not resumable;
  would show session id, folder, and typed prompts.
- **Delete session** (from ShahadIshraq): skipped deliberately — destructive,
  and transcript loss is the enemy here, not the goal.
- **Richer click-preview**: if expanding to prompts isn't enough context,
  a read-only preview tab (title, metadata, first/last prompts, files
  touched) on double-click or a dedicated "Preview" context command.
