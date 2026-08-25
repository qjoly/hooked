import { json } from '@sveltejs/kit';
import { scanSessions, buildFileChanges, buildFileChangeFull } from '$lib/server/core.js';
import { fail } from '$lib/server/respond.js';

// Full (uncapped) diff for ONE changed file, loaded on demand by the Ship lens when the capped
// entry was flagged `truncated`. The client never passes a raw arbitrary path blindly: we only
// serve a `path` that actually appears in this session's changes (anti path-traversal — otherwise
// buildFileChangeFull would read any file off disk during reconstruction).
export function GET({ url }) {
  const id = url.searchParams.get('id');
  const p = url.searchParams.get('path');
  if (!id || !p) return fail(400, 'id and path required');
  const s = scanSessions().find((x) => x.id === id);
  if (!s || !s.file) return fail(404, 'session not found');
  const allowed = buildFileChanges(s.file, id).some((c) => c.file === p);
  if (!allowed) return fail(404, 'file not in this session changes');
  const entry = buildFileChangeFull(s.file, p, id);
  if (!entry) return fail(404, 'no changes for this file');
  return json({ change: entry });
}
