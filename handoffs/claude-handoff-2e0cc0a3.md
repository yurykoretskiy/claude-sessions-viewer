# Claude handoff — session 2e0cc0a3 (founding session)

**Agent**: Claude Code (Fable 5) · **Session**: `2e0cc0a3-bf57-4af8-8bf1-b8bfee5bde47` · **Dates**: 05–06 Jul 2026 · **Status**: done — shipped through v1.4.0 + public release

## Focus

Built the extension from zero and took it public: tree, working-folder
attribution, launchers, conversation viewer, reveal-current-session, docs,
screenshots, GitHub Releases.

## State

- [x] v1.0.0–v1.4.0 shipped (see `CHANGELOG.md`; git tag + `.vsix` Release each)
- [x] Repo PUBLIC: [github.com/yurykoretskiy/claude-sessions-viewer](https://github.com/yurykoretskiy/claude-sessions-viewer) — LICENSE, topics, README with staged screenshots, Releases v1.3.0/v1.4.0
- [x] Legacy snapshot tool imported as branch `legacy-snapshot-viewer`; its cleaning logic ported into `conversation.js` (161/161 transcripts parse, ≤203 ms @ 49 MB)
- [x] `cleanupPeriodDays: 365` set in `~/.claude/settings.json` (default 30 was auto-deleting transcripts)
- [x] Global rules updated this session: Obsidian auto-tracking dropped; GitHub = one private repo per project (this one deliberately public)
- [!] v1.4.1–v1.4.5 are **Codex's work** (`[gpt] c19d207`): reveal is now tree-first with onboarding choice; prompt children + live refresh off by default. Do not claim or rewrite; if disagreeing, add a new finding that links both sides (lane rule).
- [ ] Yury has not yet visually confirmed the reveal tab-button + tree highlight on his machine

## Next step

Ask Yury whether v1.4.5's reveal/review defaults feel right in daily use; fix
what he reports. (Terminal TUI: decided **skip** — existing tools cover it;
see marketplace finding.)

## Routing

- Requirements: `inputs/index.md` → INPUT-001
- Verified knowledge: `findings/` (storage facts · official-extension limits · marketplace/TUI landscape)
- Plans: `docs/viewer-implementation-plan.md`, `docs/feature-plan.md` · parked: `BACKLOG.md`
- Invariants + build/deploy contract: `AGENTS.md` (version bump per install, INDEX_VERSION on index-shape change, passive clicks, em-space padding)
- Design mocks behind all screenshots: `poc/viewer-poc.html`, `poc/reveal-mock.html`

## Suggested skills

`/code-review` before the next release · `verify` after UI-behavior changes.
