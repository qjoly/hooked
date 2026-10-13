/*
 * Tool-call trace of a session, profiler style: one span per tool_use, timed from the assistant
 * line that issued it to the user line carrying its tool_result, grouped by user turn.
 * Inputs and outputs are NOT in the span list (thousands of calls would weigh megabytes): the
 * lens fetches one span's detail on click through readToolDetail.
 */
import fs from 'node:fs';
import { chatText, toolDetail, toolInputText, toolResultText } from './util.js';

const ms = (ts) => { const t = Date.parse(ts); return Number.isFinite(t) ? t : null; };

function buildTrace(fp) {
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return { turns: [] }; }
  const turns = [];
  const byId = new Map();
  let turn = null;
  for (const line of data.split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.isSidechain) continue;
    const t = ms(j.timestamp);
    const c = j.message && j.message.content;
    if (j.type === 'user' && j.message) {
      const results = Array.isArray(c) ? c.filter((b) => b && b.type === 'tool_result') : [];
      if (results.length) {
        for (const b of results) {
          const span = byId.get(b.tool_use_id);
          if (!span) continue;
          span.end = t;
          span.error = !!b.is_error;
          if (turn && t) turn.end = Math.max(turn.end || 0, t);
        }
      } else if (!j.isMeta && !j.isCompactSummary) {
        // Skill bodies and compaction summaries are injected mid-turn: they must not split it.
        turn = { prompt: chatText(c).replace(/\s+/g, ' ').slice(0, 160), start: t, end: t, spans: [] };
        turns.push(turn);
      }
    } else if (j.type === 'assistant' && Array.isArray(c)) {
      // A session can open on an assistant line (resume, fork): give it an anonymous turn.
      if (!turn) { turn = { prompt: '', start: t, end: t, spans: [] }; turns.push(turn); }
      if (t) turn.end = Math.max(turn.end || 0, t);
      for (const b of c) {
        if (b.type !== 'tool_use' || !b.id || byId.has(b.id)) continue;
        const span = { id: b.id, name: b.name, detail: toolDetail(b.input), start: t, end: null, error: false };
        byId.set(b.id, span);
        turn.spans.push(span);
      }
    }
  }
  return { turns: turns.filter((x) => x.spans.length) };
}

// Input and result of a single tool call, found by tool_use_id. The substring pre-filter keeps
// this from JSON-parsing the whole transcript.
function readToolDetail(fp, toolId) {
  if (!fp || !toolId) return null;
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return null; }
  let out = null;
  for (const line of data.split('\n')) {
    if (!line || !line.includes(toolId)) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    for (const b of (j.message && Array.isArray(j.message.content) ? j.message.content : [])) {
      if (b.type === 'tool_use' && b.id === toolId) out = { ...out, input: toolInputText(b.input) };
      if (b.type === 'tool_result' && b.tool_use_id === toolId) out = { ...out, result: toolResultText(b.content), error: !!b.is_error };
    }
  }
  return out;
}

export { buildTrace, readToolDetail };
