// Conversation extractor — ported from legacy build_snapshot.py
// (branch legacy-snapshot-viewer). Streams one session .jsonl and returns a
// clean conversation: user + assistant text kept, tool calls collapsed to
// one-line markers, tool outputs / thinking / base64 / sidechains dropped.
// Runs lazily, only when a session is opened — never during indexing.

const fs = require('fs');
const readline = require('readline');

const MSG_CHAR_CAP = 8000; // stored per message; the webview display-caps lower

function textFromContent(content) {
  // Returns { text, tools: [names…] }
  if (typeof content === 'string') return { text: content, tools: [] };
  if (!Array.isArray(content)) return { text: '', tools: [] };
  const parts = [];
  const tools = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text) parts.push(block.text);
    else if (block.type === 'tool_use') tools.push(block.name || 'tool');
    else if (block.type === 'tool_result') tools.push('tool result');
    // thinking / images / documents: dropped
  }
  return { text: parts.join('\n').trim(), tools };
}

// Coalesce a run of tool names into "[tool: Bash] ×14 · [tool: Read] ×3"
function toolMarker(names) {
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
  return [...counts.entries()]
    .map(([n, c]) => `[tool: ${n}]${c > 1 ? ` ×${c}` : ''}`)
    .join(' · ');
}

async function extractConversation(jsonlPath) {
  const messages = []; // {role: 'user'|'assistant'|'tool', text, ts}
  let pendingTools = [];
  let firstTs = null;
  let lastTs = null;

  const flushTools = (ts) => {
    if (pendingTools.length) {
      messages.push({ role: 'tool', text: toolMarker(pendingTools), ts });
      pendingTools = [];
    }
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if ((obj.type !== 'user' && obj.type !== 'assistant') || !obj.message) continue;
    if (obj.isSidechain || obj.isMeta) continue;

    const ts = obj.timestamp || null;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }
    const { text, tools } = textFromContent(obj.message.content);
    pendingTools.push(...tools);

    if (text && !text.startsWith('<')) {
      flushTools(ts);
      const role = obj.type === 'user' ? 'user' : 'assistant';
      const capped = text.length > MSG_CHAR_CAP ? text.slice(0, MSG_CHAR_CAP) + ' …[truncated]' : text;
      // Merge consecutive assistant chunks of one turn into one bubble.
      const prev = messages[messages.length - 1];
      if (prev && prev.role === role && role === 'assistant' && prev.ts === ts) {
        prev.text += '\n\n' + capped;
      } else {
        messages.push({ role, text: capped, ts });
      }
    }
  }
  flushTools(lastTs);
  return { messages, firstTs, lastTs };
}

// Render the conversation as plain markdown-ish text (for copy / export).
// opts: { title, folder, userLabel, names (bool), filter ('all'|'user'|'assistant'), withTools }
function conversationToText(convo, opts) {
  const o = Object.assign(
    { title: '', folder: '', userLabel: 'USER', names: true, filter: 'all', withTools: false },
    opts
  );
  const lines = [];
  if (o.title) lines.push(`# ${o.title}`, '');
  for (const m of convo.messages) {
    if (m.role === 'tool') {
      if (o.withTools && o.filter === 'all') lines.push(m.text, '');
      continue;
    }
    if (o.filter !== 'all' && m.role !== o.filter) continue;
    const label = m.role === 'user' ? o.userLabel : 'CLAUDE';
    lines.push(o.names ? `**${label}:** ${m.text}` : m.text, '');
  }
  return lines.join('\n').trim() + '\n';
}

module.exports = { extractConversation, conversationToText };
