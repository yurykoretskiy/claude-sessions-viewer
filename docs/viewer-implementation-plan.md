# Conversation Viewer — implementation, deployment, testing plan

Approved direction (06 Jul 2026, INPUT-001): read-only WhatsApp-style
session viewer inside VS Code. This plan executes after Yury approves the
design mockup in `poc/viewer-poc.html`.

## What will be built (v1.3.0)

### 1. `conversation.js` — the extractor (port from legacy branch)
Port the proven cleaning rules from `legacy-snapshot-viewer:build_snapshot.py`
(`text_from_content`, `load_session`, `truncate`) to Node:

- keep **user text** and **assistant text**;
- collapse tool calls to one-line `[tool: Bash]` chips; drop tool outputs,
  thinking, base64, sidechains, meta/system lines;
- cap a message at 4,000 chars (per-message "show more" keeps the rest
  available on click);
- output: `{meta: {id, title, folder, cwd, start, end, count}, messages:
  [{role, text, ts, isTool}]}`.

Runs **lazily** — only when a session is opened, never during indexing.
Startup speed is untouched.

### 2. Webview panel — the viewer
- **Open**: 👁 inline button on a session row + "Open as conversation"
  context item + (single click on a session keeps expanding prompts — no
  behavior change, nothing ever runs on click).
- **Layout**: header (title, folder chip, id, dates, message count) with
  three explicit buttons: `▶ Resume in terminal` · `Export Markdown` ·
  `Open raw .jsonl`. Below: chat — Yury right, Claude left, tool chips
  centered and dimmed, day separators.
- **Style**: VS Code theme variables (follows light/dark automatically)
  with Claude-brand accent (terracotta) for Yury's bubbles; Claude's
  spark ✳ avatar on assistant side. Local codicon-style SVGs only (webview
  CSP allows no external resources).
- **Performance**: windowed rendering — newest 200 messages first,
  "↑ load earlier" button prepends older chunks. Target: 30 MB session
  opens < 2 s.

### 3. `Export Markdown` (Tier 1, same extractor)
Header button + context-menu command: writes `<title>.md`
(`**Yury:** / **Claude:**` blocks) via save dialog — point it at the
Obsidian vault; markdown is Obsidian/Notion-native.

## Deployment

1. `INDEX_VERSION` untouched (index unchanged) — no re-index on update.
2. Bump `version` → 1.3.0, `./build-vsix.sh --install`, reload window.
3. Commit `[cc]`, tag `v1.3.0`, push to GitHub with tags.
4. Rollback path: `code --install-extension claude-sessions-viewer-1.2.0.vsix`.

## Testing (before "done" is claimed)

**Headless (scriptable, run first):**
- Extractor over the full corpus: every session parses without throw;
  report min/median/max parse time.
- The 30 MB session (`ad6c06bf`): parse time < 2 s, message count sane,
  output JSON < 5 MB.
- Golden checks: a known session must yield first/last message matching
  the transcript; zero `thinking`/base64 fragments in output.

**Manual in VS Code (checklist with Yury):**
- Open small, huge, untitled, and ghost-title sessions from the tree.
- Theme switch light ↔ dark while viewer open — colors follow.
- "Load earlier" pages backwards correctly; "show more" expands a capped
  message.
- Resume button opens terminal at correct cwd and runs `claude --resume`
  — and NOTHING runs without pressing it.
- Export produces a clean .md; open it in Obsidian.

## Out of scope (BACKLOG.md)
Search inside conversation (fast-follow candidate), tags/notes, diffs,
Notion API push, live tail.
