import { json } from '@sveltejs/kit';
import { scanSessions, buildTrace, readToolDetail } from '$lib/server/core.js';
import { fail } from '$lib/server/respond.js';

// Trace lens: the span list, or one span's input/result when `tool` (a tool_use_id) is given.
export function GET({ url }) {
  const id = url.searchParams.get('id');
  const tool = url.searchParams.get('tool');
  if (!id) return fail(400, 'id required');
  const s = scanSessions().find((x) => x.id === id);
  if (!s || !s.file) return fail(404, 'session not found');
  if (!tool) return json(buildTrace(s.file));
  const d = readToolDetail(s.file, tool);
  return d ? json(d) : fail(404, 'tool call not found');
}
