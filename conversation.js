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
    const mediaTypes = [
      ...new Set(attachments.filter((a) => a.kind === 'image').map((a) => a.mediaType || a.media).filter(Boolean)),
    ];
    parts.push(`image attachment x${imageCount}${mediaTypes.length ? ` (${mediaTypes.join(', ')})` : ''}`);
  }
  if (documentCount) parts.push(`document attachment x${documentCount}`);
  return `[${parts.join(' · ')}]`;
}

function textFromContent(content) {
  // Returns { text, tools: [names…], attachments: [{kind, mediaType, data}] }
  if (typeof content === 'string') {
    const commandText = commandTextFromMarkup(content);
    if (commandText) return { text: commandText, tools: [], attachments: [] };
    return { text: content.startsWith('<') ? '' : content, tools: [], attachments: [] };
  }
  if (!Array.isArray(content)) return { text: '', tools: [], attachments: [] };
  const parts = [];
  const tools = [];
  const attachments = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text) parts.push(block.text);
    else if (block.type === 'tool_use') tools.push(block.name || 'tool');
    else if (block.type === 'tool_result') tools.push('tool result');
    else if (block.type === 'image')
      attachments.push({
        kind: 'image',
        mediaType: block.source && block.source.media_type,
        sourceType: block.source && block.source.type,
        data: block.source && block.source.data,
      });
    else if (block.type === 'document') attachments.push({ kind: 'document' });
    // thinking / other non-readable blocks: dropped
  }
  return { text: parts.join('\n').trim(), tools, attachments };
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
  const attachmentsById = {};
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
    const { text, tools, attachments } = textFromContent(obj.message.content);
    pendingTools.push(...tools);

    if (text || (attachments && attachments.length)) {
      flushTools(ts);
      const role = obj.type === 'user' ? 'user' : 'assistant';
      const capped = text.length > MSG_CHAR_CAP ? text.slice(0, MSG_CHAR_CAP) + ' …[truncated]' : text;
      const messageAttachments = [];
      for (const a of attachments || []) {
        if (a.kind !== 'image' || !a.data || a.sourceType !== 'base64') continue;
        const id = `att-${Object.keys(attachmentsById).length + 1}`;
        const meta = { id, kind: a.kind, mediaType: a.mediaType || 'image/png' };
        attachmentsById[id] = { ...meta, data: a.data };
        messageAttachments.push(meta);
      }
      const model = role === 'assistant' ? obj.message.model || null : undefined;
      // Merge consecutive assistant chunks of one turn into one bubble.
      const prev = messages[messages.length - 1];
      if (prev && prev.role === role && role === 'assistant' && prev.ts === ts) {
        prev.text += '\n\n' + capped;
        if (messageAttachments.length) prev.attachments = [...(prev.attachments || []), ...messageAttachments];
      } else {
        const entry = { role, text: capped, ts, attachments: messageAttachments };
        if (role === 'assistant') entry.model = model;
        messages.push(entry);
      }
    }
  }
  flushTools(lastTs);
  return { messages, attachmentsById, firstTs, lastTs };
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
    const attachment = attachmentLabel(m.attachments || []);
    const body = [attachment, m.text].filter(Boolean).join('\n');
    lines.push(o.names ? `**${label}:** ${body}` : body, '');
  }
  return lines.join('\n').trim() + '\n';
}

// Collapses the assistant `model` field into contiguous runs — which model
// handled which stretch of the conversation. A run's span extends through
// any interleaved user/tool messages up to the next model switch, so the
// whole transcript is covered with no gaps. `<synthetic>` (harness-injected)
// and model-less turns don't start or extend a run; they're simply skipped.
function computeModelRuns(messages) {
  const runs = [];
  let currentModel = null;
  messages.forEach((m, i) => {
    if (m.role !== 'assistant' || !m.model || m.model === '<synthetic>') return;
    if (m.model !== currentModel) {
      currentModel = m.model;
      runs.push({ model: currentModel, startIndex: i, endIndex: i, turns: 0, tsStart: null, tsEnd: null });
    }
    const run = runs[runs.length - 1];
    run.turns++;
    run.endIndex = i;
    if (!run.tsStart) run.tsStart = m.ts || null;
    run.tsEnd = m.ts || run.tsEnd;
  });
  for (let r = 0; r < runs.length; r++) {
    runs[r].endIndex = r + 1 < runs.length ? runs[r + 1].startIndex - 1 : messages.length - 1;
  }
  if (runs.length) runs[0].startIndex = 0;
  return runs;
}

module.exports = { extractConversation, conversationToText, textFromContent, computeModelRuns, MSG_CHAR_CAP };
