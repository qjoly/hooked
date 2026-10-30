// The full result of a Grafana query tool call (Prometheus / Loki), read back from the transcript
// to draw it in the dashboard. Nothing is re-queried: hooked has no access to the MCP server.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './config.js';
import { agentTranscriptPath } from './transcript.js';
import { sessionTranscriptPath } from './userFiles.js';

// Matched on the suffix: the same gateway is configured under different server names.
export const QUERY_TOOL = /__grafana_query_(prometheus|loki)$/;
const MAX_LOG_LINES = 2000;

// Labels shared by every series say nothing about which line is which, so they are dropped.
function labeller(metrics) {
  const shared = new Set(Object.keys(metrics[0] || {}).filter((k) =>
    metrics.length > 1 && metrics.every((m) => m?.[k] === metrics[0][k])));
  return (m) => {
    const name = m?.__name__ || '';
    const rest = Object.entries(m || {}).filter(([k]) => k !== '__name__' && !shared.has(k));
    return rest.length ? `${name}{${rest.map(([k, v]) => `${k}="${v}"`).join(', ')}}` : name || '{}';
  };
}

export function parseQueryResult(body) {
  if (body?.error) return { kind: 'error', error: String(body.error) };
  const d = body?.data;
  if (d?.resultType === 'scalar') return { kind: 'table', rows: [{ label: 'scalar', value: Number(d.result?.[1]) }] };
  const rows = Array.isArray(d?.result) ? d.result : [];
  if (d?.resultType === 'matrix') {
    const label = labeller(rows.map((r) => r.metric));
    return { kind: 'series', series: rows.map((r) => ({
      label: label(r.metric), points: (r.values || []).map(([t, v]) => [t * 1000, Number(v)]),
    })) };
  }
  if (d?.resultType === 'vector') {
    const label = labeller(rows.map((r) => r.metric));
    return { kind: 'table', rows: rows.map((r) => ({ label: label(r.metric), value: Number(r.value?.[1]) })) };
  }
  if (d?.resultType === 'streams') {
    const label = labeller(rows.map((r) => r.stream));
    const lines = rows.flatMap((r) => (r.values || []).map(([ns, line]) => ({
      t: Math.floor(Number(ns) / 1e6), level: r.stream?.detected_level || r.stream?.level || '', labels: label(r.stream), line,
    })));
    return { kind: 'logs', total: lines.length, lines: lines.sort((a, b) => b.t - a.t).slice(0, MAX_LOG_LINES) };
  }
  return { kind: 'error', error: `Unsupported result type: ${d?.resultType || 'none'}` };
}

const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text || '').join('') : '');

export function readQueryResult(sessionId, agentId, toolUseId, projectsDir = PROJECTS_DIR) {
  if (!/^[A-Za-z0-9_-]+$/.test(toolUseId || '')) return null;
  const main = sessionTranscriptPath(sessionId, projectsDir);
  const fp = agentId ? agentTranscriptPath(sessionId, agentId, projectsDir) : main;
  if (!main || !fp) return null;
  let use = null, result = null;
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    if (!line.includes(toolUseId)) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    const c = j?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type === 'tool_use' && b.id === toolUseId) use = b;
      if (b?.type === 'tool_result' && b.tool_use_id === toolUseId) result = b.content;
    }
  }
  // show_query carries only the query: the window runs it live.
  if (use?.name === 'mcp__hooked__show_query') return { tool: use.input?.tool, input: use.input || {}, data: null };
  const m = use && QUERY_TOOL.exec(use.name);
  if (!m) return null;
  let text = resultText(result);
  // A large result is saved next to the transcript: only the file name is taken from the message.
  const saved = /\/tool-results\/([^\s/]+?\.(?:txt|json))/.exec(text);
  if (saved) {
    try { text = fs.readFileSync(path.join(path.dirname(main), sessionId, 'tool-results', saved[1]), 'utf8'); }
    catch (_) { text = JSON.stringify({ error: 'The saved result file is gone' }); }
  }
  let body;
  try { body = JSON.parse(text); } catch (_) { body = { error: text.trim().slice(0, 300) || 'No result yet' }; }
  // Some CLI versions save the tool's content blocks rather than their text.
  if (Array.isArray(body)) {
    try { body = JSON.parse(resultText(body)); } catch (_) { body = { error: 'Unreadable saved result' }; }
  }
  return { tool: m[1], input: use.input || {}, data: parseQueryResult(body) };
}
