#!/usr/bin/env python3
# claude
"""
build_snapshot.py — static snapshot of all Claude Code sessions.

Reads ~/.claude/projects/<encoded-cwd>/<session>.jsonl and emits, into ./snapshot/:
  - index.json                       structured metadata (projects -> sessions), for grep/processing
  - claude-code-snapshot-<date>.html single self-contained viewer (data embedded), zero server

Prose (user + assistant text) is kept; tool calls become one-line [tool: X] markers;
giant tool outputs / base64 / thinking are dropped so 90+ MB of raw JSONL becomes a small file.
"""
import json
import os
import sys
import html
from datetime import datetime, timezone
from pathlib import Path

PROJECTS_DIR = Path.home() / ".claude" / "projects"
OUT_DIR = Path(__file__).resolve().parent / "snapshot"
MSG_CHAR_CAP = 4000          # truncate any single message body to this many chars
TITLE_CHARS = 90


def parse_ts(s):
    """ISO8601 -> aware datetime, or None."""
    if not s or not isinstance(s, str):
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def text_from_content(content):
    """Flatten a message 'content' (str or list of blocks) into display text + tool markers."""
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            parts.append((block.get("text") or "").strip())
        elif btype == "tool_use":
            parts.append(f"[tool: {block.get('name', 'tool')}]")
        elif btype == "tool_result":
            parts.append("[tool result]")
        # thinking / image / etc. intentionally skipped
    return "\n".join(p for p in parts if p).strip()


def truncate(s, cap=MSG_CHAR_CAP):
    s = s or ""
    return s if len(s) <= cap else s[:cap].rstrip() + " …"


def load_session(jsonl_path):
    """Parse one .jsonl session file into a dict, or None if it has no real messages."""
    session_id = jsonl_path.stem
    cwd = None
    summary = None
    first_user = None
    messages = []
    ts_min = ts_max = None

    with jsonl_path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue

            if d.get("cwd") and not cwd:
                cwd = d["cwd"]

            ltype = d.get("type")

            if ltype == "summary" and d.get("summary") and not summary:
                summary = d["summary"]
                continue

            if ltype not in ("user", "assistant"):
                continue

            ts = parse_ts(d.get("timestamp"))
            if ts:
                ts_min = ts if ts_min is None or ts < ts_min else ts_min
                ts_max = ts if ts_max is None or ts > ts_max else ts_max

            msg = d.get("message") or {}
            role = msg.get("role") or ltype
            body = truncate(text_from_content(msg.get("content")))
            if not body:
                continue
            # skip noisy injected reminders / command stdout as the title source, but keep in transcript
            if role == "user" and first_user is None and not body.startswith(("<", "[tool")):
                first_user = body
            messages.append({"role": role, "text": body,
                             "ts": ts.isoformat() if ts else None})

    if not messages:
        return None

    title = summary or (first_user[:TITLE_CHARS] if first_user else session_id[:8])
    return {
        "id": session_id,
        "cwd": cwd or jsonl_path.parent.name,
        "title": title.strip(),
        "start": ts_min.isoformat() if ts_min else None,
        "end": ts_max.isoformat() if ts_max else None,
        "msg_count": len(messages),
        "messages": messages,
    }


def project_label(cwd):
    """Human label for a project path: keep last 2 path segments."""
    parts = [p for p in cwd.replace("\\", "/").split("/") if p]
    return "/".join(parts[-2:]) if len(parts) >= 2 else (parts[-1] if parts else cwd)


def build():
    if not PROJECTS_DIR.is_dir():
        sys.exit(f"No projects dir at {PROJECTS_DIR}")

    projects = {}  # cwd -> {label, sessions:[]}
    for jsonl in PROJECTS_DIR.rglob("*.jsonl"):
        sess = load_session(jsonl)
        if not sess:
            continue
        key = sess["cwd"]
        projects.setdefault(key, {"path": key, "name": project_label(key), "sessions": []})
        projects[key]["sessions"].append(sess)

    # sort sessions newest-first; projects by most-recent activity
    proj_list = []
    for p in projects.values():
        p["sessions"].sort(key=lambda s: s["start"] or "", reverse=True)
        p["last"] = p["sessions"][0]["start"] if p["sessions"] else ""
        proj_list.append(p)
    proj_list.sort(key=lambda p: p["last"], reverse=True)

    generated = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    total_sessions = sum(len(p["sessions"]) for p in proj_list)

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # index.json: metadata only (drop transcripts to keep it grep-friendly)
    index = {
        "generated": generated,
        "project_count": len(proj_list),
        "session_count": total_sessions,
        "projects": [
            {"name": p["name"], "path": p["path"],
             "sessions": [{k: s[k] for k in ("id", "title", "start", "end", "msg_count")}
                          for s in p["sessions"]]}
            for p in proj_list
        ],
    }
    index_path = OUT_DIR / "index.json"
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")

    # HTML: full data (incl. transcripts) embedded
    data_json = json.dumps({"generated": generated, "projects": proj_list},
                           ensure_ascii=False, separators=(",", ":"))
    date_tag = datetime.now().strftime("%Y-%m-%d")
    html_path = OUT_DIR / f"claude-code-snapshot-{date_tag}.html"
    html_path.write_text(render_html(data_json, generated, len(proj_list), total_sessions),
                         encoding="utf-8")

    print(f"projects: {len(proj_list)}  sessions: {total_sessions}")
    print(f"index.json: {index_path}  ({index_path.stat().st_size/1024:.0f} KB)")
    print(f"html:       {html_path}  ({html_path.stat().st_size/1024/1024:.1f} MB)")
    print(html_path)  # last line = path, for the slash command to open


HTML_TEMPLATE = r"""<!DOCTYPE html>
<!-- claude -->
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code Sessions — snapshot __GEN__</title>
<style>
  :root { --bg:#1a1a1a; --panel:#222; --line:#333; --fg:#e6e6e6; --mut:#888; --acc:#c8794f; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         background:var(--bg); color:var(--fg); height:100vh; display:flex; flex-direction:column; }
  header { padding:10px 16px; border-bottom:1px solid var(--line); display:flex; gap:14px;
           align-items:center; flex:0 0 auto; }
  header h1 { font-size:14px; margin:0; font-weight:600; }
  header .meta { color:var(--mut); font-size:12px; }
  header input { margin-left:auto; background:var(--panel); border:1px solid var(--line);
                 color:var(--fg); padding:6px 10px; border-radius:6px; width:280px; }
  .body { flex:1 1 auto; display:flex; min-height:0; }
  aside { width:340px; flex:0 0 auto; border-right:1px solid var(--line); overflow:auto; }
  .proj > .phead { padding:8px 12px; cursor:pointer; font-weight:600; display:flex; gap:6px;
                   position:sticky; top:0; background:var(--bg); border-bottom:1px solid var(--line); }
  .proj .pcount { color:var(--mut); font-weight:400; }
  .sess { padding:6px 12px 6px 24px; cursor:pointer; border-bottom:1px solid #2a2a2a; }
  .sess:hover { background:#2a2a2a; }
  .sess.active { background:#33291f; border-left:2px solid var(--acc); }
  .sess .t { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sess .s { color:var(--mut); font-size:11px; }
  .proj.collapsed .sess { display:none; }
  main { flex:1 1 auto; overflow:auto; padding:18px 26px; }
  main .empty { color:var(--mut); margin-top:40px; text-align:center; }
  .shead { border-bottom:1px solid var(--line); padding-bottom:10px; margin-bottom:14px; }
  .shead .crumb { color:var(--acc); font-weight:600; }
  .shead .sub { color:var(--mut); font-size:12px; }
  .msg { margin:0 0 14px; }
  .msg .role { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--mut); }
  .msg.user .role { color:#6ea8fe; }
  .msg.assistant .role { color:var(--acc); }
  .msg .txt { white-space:pre-wrap; word-break:break-word; margin-top:2px; }
  .msg .txt.tool { color:var(--mut); font-family:ui-monospace,monospace; font-size:12px; }
</style></head>
<body>
<header>
  <h1>Claude Code Sessions</h1>
  <span class="meta">__NPROJ__ projects · __NSESS__ sessions · snapshot __GEN__</span>
  <input id="q" placeholder="filter projects / sessions…" autocomplete="off">
</header>
<div class="body">
  <aside id="side"></aside>
  <main id="main"><div class="empty">Select a session on the left.</div></main>
</div>
<script id="data" type="application/json">__DATA__</script>
<script>
const DATA = JSON.parse(document.getElementById("data").textContent);
const side = document.getElementById("side"), main = document.getElementById("main");
let active = null;

function rel(iso){ if(!iso) return ""; const d=new Date(iso), s=(Date.now()-d)/1000;
  if(s<3600) return Math.floor(s/60)+"m"; if(s<86400) return Math.floor(s/3600)+"h";
  return Math.floor(s/86400)+"d"; }
function fmt(iso){ return iso ? new Date(iso).toLocaleString() : "—"; }

function renderSide(){
  side.innerHTML = "";
  DATA.projects.forEach((p, pi) => {
    const proj = document.createElement("div"); proj.className = "proj";
    const head = document.createElement("div"); head.className = "phead";
    head.innerHTML = `<span>▸</span><span>${esc(p.name)}</span><span class="pcount">${p.sessions.length}</span>`;
    head.onclick = () => { proj.classList.toggle("collapsed");
      head.firstChild.textContent = proj.classList.contains("collapsed") ? "▸" : "▾"; };
    proj.appendChild(head);
    p.sessions.forEach((s, si) => {
      const el = document.createElement("div"); el.className = "sess";
      el.dataset.pi = pi; el.dataset.si = si;
      el.innerHTML = `<span class="t">${esc(s.title)}</span><span class="s">${rel(s.start)} · ${s.msg_count} msgs</span>`;
      el.onclick = () => openSession(pi, si, el);
      proj.appendChild(el);
    });
    head.firstChild.textContent = "▾";
    side.appendChild(proj);
  });
}

function openSession(pi, si, el){
  if(active) active.classList.remove("active");
  el.classList.add("active"); active = el;
  const p = DATA.projects[pi], s = p.sessions[si];
  let h = `<div class="shead"><div class="crumb">${esc(p.name)} / ${esc(s.id.slice(0,8))}</div>`
        + `<div class="sub">${fmt(s.start)} → ${fmt(s.end)} · ${s.msg_count} messages</div></div>`;
  for(const m of s.messages){
    const tool = m.text.startsWith("[tool");
    h += `<div class="msg ${esc(m.role)}"><div class="role">${esc(m.role)}</div>`
       + `<div class="txt${tool?' tool':''}">${esc(m.text)}</div></div>`;
  }
  main.innerHTML = h; main.scrollTop = 0;
}

function esc(s){ return (s==null?"":String(s)).replace(/[&<>"]/g, c =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c])); }

document.getElementById("q").addEventListener("input", e => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll(".proj").forEach(proj => {
    let any = false;
    proj.querySelectorAll(".sess").forEach(se => {
      const hit = se.textContent.toLowerCase().includes(q);
      se.style.display = hit ? "" : "none"; if(hit) any = true;
    });
    const ph = proj.querySelector(".phead");
    const pm = ph.textContent.toLowerCase().includes(q);
    proj.style.display = (any || pm || !q) ? "" : "none";
    if(q){ proj.classList.remove("collapsed"); ph.firstChild.textContent = "▾"; }
  });
});

renderSide();
</script>
</body></html>"""


def render_html(data_json, generated, nproj, nsess):
    # Neutralize "</script>" breakout: '<' -> '<' (JSON.parse restores it).
    safe_data = data_json.replace("<", "\\u003c")
    return (HTML_TEMPLATE
            .replace("__GEN__", html.escape(generated))
            .replace("__NPROJ__", str(nproj))
            .replace("__NSESS__", str(nsess))
            .replace("__DATA__", safe_data))


if __name__ == "__main__":
    build()
