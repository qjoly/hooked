import { json } from '@sveltejs/kit';
import { scanSessions, listVcsBranches } from '$lib/server/core.js';

// Local branches (git) / bookmarks (jj) of one of the session's repos — the primary one by
// default, or `root` (re-validated server-side against the detected repos). Feeds the branch
// picker of the Branch lens. Lazy like vcs-diff: never re-called by the SSE tick.
export async function GET({ url }) {
  const id = url.searchParams.get('id');
  const root = url.searchParams.get('root') || null;
  const s = scanSessions().find((x) => x.id === id);
  const cwd = s ? s.project : null;
  if (!cwd) return json({ vcs: null, root: null, branches: [], default: null, repos: [] });
  return json(await listVcsBranches(cwd, root));
}
