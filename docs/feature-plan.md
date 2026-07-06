# Feature plan — conversation view & export (approved for planning only, 06 Jul 2026)

Yury's wants (INPUT-001): read sessions like WhatsApp — his inputs on the
right, Claude's answers on the left, ALL intermediate machinery (tool calls,
thinking, system noise) hidden; open a whole session read-only without
resuming it; later export sessions to Obsidian/Notion.

## Core insight

All three wants share one component: a **conversation extractor** —
transcript `.jsonl` → clean `[{role, text, ts}]` list (user text +
assistant text only; skip tool_use/tool_result/thinking/sidechains/meta).
Build it once in `indexer.js` style; every feature below is a different
renderer on top of it.

## Tier 1 — easily done (hours, low risk)

1. **Export session as Markdown** — context-menu command; writes
   `<title>.md` with `**Yury:** … / **Claude:** …` blocks. Save-dialog
   target (point it at the Obsidian vault — Obsidian's native format IS
   markdown, so no Obsidian plugin is needed; this is the best practice vs
   building a converter plugin). Also "copy as markdown" for pasting into
   Notion (Notion imports markdown cleanly). Risk: near zero.
2. **Outputs in the tree** — under each session, show paired
   `→ input / ← output` rows instead of inputs only (first line of each
   answer). Needs `INDEX_VERSION` bump + full one-time reindex. Risk: cache
   size growth — cap snippet length.

## Tier 2 — needs testing (a day-ish, real unknowns)

3. **WhatsApp-style conversation webview** — "Open as conversation"
   command: VS Code webview panel, chat bubbles (user right / assistant
   left), rendered markdown, read-only, jump-to-search. Unknowns to test:
   30MB sessions need lazy/windowed rendering; markdown rendering inside
   webview CSP; theme (light/dark) fidelity.
4. **Toggle in conversation view: "clean ↔ full"** — optional switch to
   also reveal the intermediate steps (tool calls collapsed as one-liners).
   Depends on 3.

## Notion/Obsidian lane (decide later)

- Obsidian: covered by Tier 1 export into the vault folder. If Yury wants
  live browsing instead of exports, an Obsidian plugin reading
  `~/.claude/projects` directly is possible but is a separate project.
- Notion: markdown copy-paste first; if pipelines are wanted, Notion MCP
  page creation from the same extractor output (needs per-call approval
  per house rules).

## Explicitly out (see BACKLOG.md)

Tags, saved searches, diffs viewer (install hiztam's extension instead),
ghost sessions, delete.
