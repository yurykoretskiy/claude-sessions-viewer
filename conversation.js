// Conversation extractor — ported from legacy build_snapshot.py
// (branch legacy-snapshot-viewer). Streams one session .jsonl and returns a
// clean conversation: user + assistant text kept, tool calls collapsed to
// one-line markers, tool outputs / thinking / base64 / sidechains dropped.
// Runs lazily, only when a session is opened — never during indexing.

const fs = require('fs');
const readline = require('readline');

const MSG_CHAR_CAP = 8000; // stored per message; the webview display-caps lower

function commandTextFromMarkup(text) {
  const source = String(text || '');
  const named = source.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  if (named && named[1].trim()) return named[1].trim();
  const message = source.match(/<command-message>\s*([^<]+?)\s*<\/command-message>/);
  if (message && message[1].trim()) {
    const value = message[1].trim();
    return value.startsWith('/') ? value : `/${value}`;
  }
  return '';
}

function attachmentLabel(attachments) {
  if (!attachments.length) return '';
  const imageCount = attachments.filter((a) => a.kind === 'image').length;
  const documentCount = attachments.filter((a) => a.kind === 'document').length;
  const parts = [];
  if (imageCount) {
    const mediaTypes = [...new Set(attachments.filter((a) => a.kind === 'image').map((a) => a.media).filter(Boolean))];
    parts.push(`image attachment x${imageCount}${mediaTypes.length ? ` (${mediaTypes.join(', ')})` : ''}`);
  }
  if (documentCount) parts.push(`document attachment x${documentCount}`);
  return `[${parts.join(' · ')}]`;
}

function textFromContent(content) {
  // Returns { text, tools: [names…] }
  if (typeof content === 'string') {
    const commandText = commandTextFromMarkup(content);
    if (commandText) return { text: commandText, tools: [] };
    return { text: content.startsWith('<') ? '' : content, tools: [] };
  }
  if (!Array.isArray(content)) return { text: '', tools: [] };
  const parts = [];
  const tools = [];
  const attachments = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text) parts.push(block.text);
    else if (block.type === 'tool_use') tools.push(block.name || 'tool');
    else if (block.type === 'tool_result') tools.push('tool result');
    else if (block.type === 'image') attachments.push({ kind: 'image', media: block.source && block.source.media_type });
    else if (block.type === 'document') attachments.push({ kind: 'document' });
    // thinking / other non-readable blocks: dropped
  }
  const attachment = attachmentLabel(attachments);
  if (attachment) parts.unshift(attachment);
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

    if (text) {
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
// opts: { title, folder, userLabel, agentLabel, names (bool), filter ('all'|'user'|'assistant'), withTools }
function conversationToText(convo, opts) {
  const o = Object.assign(
    { title: '', folder: '', userLabel: 'USER', agentLabel: 'CLAUDE', names: true, filter: 'all', withTools: false },
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
    const label = m.role === 'user' ? o.userLabel : o.agentLabel;
    lines.push(o.names ? `**${label}:** ${m.text}` : m.text, '');
  }
  return lines.join('\n').trim() + '\n';
}

module.exports = { extractConversation, conversationToText };
