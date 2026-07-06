# Claude handoff — session 2e0cc0a3 (founding session)

**Agent**: Claude Code (Fable 5) · **Session**: `2e0cc0a3-bf57-4af8-8bf1-b8bfee5bde47` · **Dates**: 05–06 Jul 2026 · **Status**: shipped v1.1.1

## What this session did

| # | Item |
| --- | --- |
| 1 | Built the entire extension from zero → v1.1.1 (tree, smart attribution, launchers, panel-in-new-window, toggle, search, rename, prompts preview, passive click, dedupe) |
| 2 | Verified session storage facts + official-extension limits → `findings/` |
| 3 | Researched marketplace alternatives → `findings/` (nobody does attribution/launching) |
| 4 | Set `cleanupPeriodDays: 365` in `~/.claude/settings.json` (was default 30 → transcripts were being lost) |
| 5 | Wrote docs: `README.md` (human), `AGENTS.md` (agents), `BACKLOG.md` (parked), `docs/feature-plan.md` (next features, approved for planning only) |
| 6 | Dropped global Obsidian auto-tracking rule per Yury (05 Jul) |

## Routing

- Requirements: `inputs/index.md` INPUT-001
- Verified knowledge: `findings/` (3 findings, all linked to INPUT-001)
- What to build next: `docs/feature-plan.md` — Tier 1 = markdown export +
  outputs-in-tree (easy); Tier 2 = WhatsApp-style conversation webview
  (needs perf testing on 30MB transcripts). NOT approved for build yet.
- Rules that bit us: bump `version` on every install; bump `INDEX_VERSION`
  on index shape change; session click stays passive; em-space padding is
  intentional (see `AGENTS.md`).

## Known open items

- Yury reported slow first load after reload (INDEX_VERSION bump forced a
  full 146-file reindex — one-time; watcher debounce now 20s). Watch
  whether he still feels it in normal use.
- hiztam.codex-history-viewer install as reading companion — offered,
  undecided.
