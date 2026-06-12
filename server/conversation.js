'use strict';
/*
 * Reconstruit la conversation (style chat) : 1 bulle user / 1 bulle assistant par tour,
 * en fusionnant l'activité assistant entre deux prompts. Chaque tool_use porte son input
 * et son résultat (apparié par tool_use_id) pour permettre le détail au clic.
 */
const fs = require('fs');
const { chatText, toolDetail, toolInputText, toolResultText } = require('./util');

// includeSidechain : pour un transcript de sous-agent (tout est isSidechain), on garde tout.
function buildConversation(fp, includeSidechain) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return []; }
  const lines = data.split('\n');
  // passe 1 : indexe les résultats d'outils par tool_use_id
  const results = new Map();
  for (const line of lines) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.type === 'user' && j.message && Array.isArray(j.message.content)) {
      for (const b of j.message.content) {
        if (b && b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, toolResultText(b.content));
      }
    }
  }
  const msgs = [];
  for (const line of lines) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (!includeSidechain && j.isSidechain) continue;
    if (j.type === 'user' && j.message) {
      const c = j.message.content;
      if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) continue;
      const text = chatText(c);
      if (text) msgs.push({ role: 'user', ts: j.timestamp, text: text.slice(0, 8000), tools: [] });
    } else if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      let text = '';
      const tools = [];
      for (const b of j.message.content) {
        if (b.type === 'text' && b.text) text += (text ? '\n' : '') + b.text;
        else if (b.type === 'tool_use') tools.push({ id: b.id || null, name: b.name, detail: toolDetail(b.input), inputText: toolInputText(b.input), result: b.id ? (results.get(b.id) || null) : null });
      }
      text = text.trim();
      if (!text && !tools.length) continue;
      const prev = msgs[msgs.length - 1];
      if (prev && prev.role === 'assistant') { // fusion du même tour
        if (text && prev.text !== text && !prev.text.endsWith(text)) prev.text += (prev.text ? '\n' : '') + text;
        for (const t of tools) if (!prev.tools.some((x) => (t.id && x.id === t.id) || (x.name === t.name && x.detail === t.detail))) prev.tools.push(t);
        if (j.timestamp) prev.ts = j.timestamp;
      } else {
        msgs.push({ role: 'assistant', ts: j.timestamp, text: text.slice(0, 8000), tools });
      }
    }
  }
  return msgs;
}

module.exports = { buildConversation };
