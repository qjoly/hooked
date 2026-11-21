import { json } from '@sveltejs/kit';
import { findSessionAny, buildFileChanges, buildFileChangeFull, buildVcsChanges } from '#lib/server/core.js';
import { fail } from '#lib/server/respond.js';

// Full (uncapped) diff for ONE changed file, loaded on demand by the Ship lens when the capped
// entry was flagged `truncated`. The client never passes a raw arbitrary path blindly: we only
// serve a `path` that actually appears in this session's changes (anti path-traversal — otherwise
// buildFileChangeFull would read any file off disk during reconstruction).
//
// Provider vibe : pas de transcript Claude → les changements viennent du diff VCS du projet
// (buildVcsChanges produit la même shape d'entry : {file, name, badge, ops:[{old,new}]…}), et
// l'entry servie est la version VCS complète (old/new intégraux, jamais tronquée).
export async function GET({ url }) {
  const id = url.searchParams.get('id');
  const p = url.searchParams.get('path');
  if (!id || !p) return fail(400, 'id and path required');
  const s = findSessionAny(id);
  if (!s || !s.file) return fail(404, 'session not found');
  if (s.provider === 'vibe') {
    const vcs = await buildVcsChanges(s.project);
    const all = [...(vcs.changes || []), ...(vcs.repos || []).flatMap((r) => r.changes || [])];
    const entry = all.find((c) => c.file === p);
    if (!entry) return fail(404, 'file not in this session changes');
    return json({ change: entry });
  }
  const allowed = buildFileChanges(s.file, id).some((c) => c.file === p);
  if (!allowed) return fail(404, 'file not in this session changes');
  const entry = buildFileChangeFull(s.file, p, id);
  if (!entry) return fail(404, 'no changes for this file');
  return json({ change: entry });
}
