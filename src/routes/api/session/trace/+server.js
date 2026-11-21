import { json } from '@sveltejs/kit';
import { findSessionAny, buildTrace, readToolDetail, buildVibeTrace, vibeToolDetail } from '#lib/server/core.js';
import { fail } from '#lib/server/respond.js';

// Trace lens: the span list, or one span's input/result when `tool` (a tool_use_id) is given.
// Provider vibe : la trace est rebuildée depuis les effects du journal (buildVibeTrace), et le
// détail d'un span depuis vibeToolDetail (state.output, pas outputText).
export function GET({ url }) {
  const id = url.searchParams.get('id');
  const tool = url.searchParams.get('tool');
  if (!id) return fail(400, 'id required');
  const s = findSessionAny(id);
  if (!s || !s.file) return fail(404, 'session not found');
  if (s.provider === 'vibe') {
    if (!tool) return json(buildVibeTrace(s.dir));
    const d = vibeToolDetail(s.dir, tool);
    return d ? json(d) : fail(404, 'tool call not found');
  }
  if (!tool) return json(buildTrace(s.file));
  const d = readToolDetail(s.file, tool);
  return d ? json(d) : fail(404, 'tool call not found');
}
