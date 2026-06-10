# claude-session-viewer

`#claude`

Browse **all** Claude Code sessions across every project — the cross-project, chronological view the built-in `/resume` lacks. Reads `~/.claude/projects/<encoded-cwd>/<session>.jsonl`.

Two interchangeable modes, exposed as global slash commands (`~/.claude/commands/`):

| Command | Mode | RAM | Live? | Backed by |
| --- | --- | --- | --- | --- |
| `/claude-code-viewer` | Server — `@kimuson/claude-code-viewer` on `localhost:4178` | ~300 MB **while running** | Yes (interactive, can resume) | npm package (needs Node ≥24) |
| `/claude-code-snapshot` | Static snapshot — `build_snapshot.py` | ~0 resident (seconds of CPU to build) | No (snapshot, read-only) | this repo |

Run `/claude-code-viewer stop` to kill the server and free its RAM.

## Snapshot generator

```bash
python3 build_snapshot.py        # stdlib only; reads ~/.claude/projects/
```

Writes into `snapshot/`:
- `index.json` — structured metadata (projects → sessions: id, title, start/end, msg count). Grep-friendly.
- `claude-code-snapshot-<date>.html` — single self-contained viewer, all data embedded, no server. Open via VS Code Simple Browser (`file://…`).

Cleaning keeps it small (90+ MB raw JSONL → ~2–3 MB HTML): user + assistant **text** is kept; tool calls collapse to one-line `[tool: X]` markers; tool outputs / base64 / thinking are dropped; each message body is capped at 4000 chars.

## Privacy

`snapshot/` contains full transcripts across all your projects (may include secrets/PII) — it is **git-ignored** and must stay local. Never push it.
