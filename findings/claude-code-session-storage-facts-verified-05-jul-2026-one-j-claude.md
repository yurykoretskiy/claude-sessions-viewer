# Claude Code session storage facts (verified 05 Jul 2026): one jsonl per session at top level of ~/.claude/projects/<dir>/; deeper jsonl = subagent sidechains; aiTitle lines can appear anywhere or be absent; cwd in transcript is ground truth (dir-name encoding ambiguous); transcripts auto-deleted after cleanupPeriodDays (was default 30d — set to 365 in user settings); ~/.claude/history.jsonl retains prompts of purged sessions; resuming from another cwd COPIES the transcript into that project dir → same session id in multiple dirs (dedupe by freshest mtime)

<!-- #claude -->

- Date: 06-07-2026
- Based on: INPUT-001

## Finding

(fill in)
