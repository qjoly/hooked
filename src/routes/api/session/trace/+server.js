import { json } from '@sveltejs/kit';
import { findSessionAny, buildTrace, readToolDetail, engineForSession } from '#lib/server/core.js';
import { fail } from '#lib/server/respond.js';

// Trace lens: the span list, or one span's input/result when `tool` (a tool_use_id) is given.
// Other engines rebuild it from their own store (pi session file, provider journal…).
export function GET({ url }) {
  const id = url.searchParams.get('id');
  const tool = url.searchParams.get('tool');
  if (!id) return fail(400, 'id required');
  const s = findSessionAny(id);
  if (!s || !s.file) return fail(404, 'session not found');
  const eng = engineForSession(s);
  if (eng && eng.id !== 'claude') {
    if (!tool) return json(typeof eng.trace === 'function' ? eng.trace(s) : { turns: [] });
    const d = typeof eng.toolDetail === 'function' ? eng.toolDetail(s, tool) : null;
    return d ? json(d) : fail(404, 'tool call not found');
  }
  if (!tool) return json(buildTrace(s.file));
  const d = readToolDetail(s.file, tool);
  return d ? json(d) : fail(404, 'tool call not found');
}
