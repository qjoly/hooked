import { json } from '@sveltejs/kit';
import { scanSessions, buildVcsBranchChanges } from '$lib/server/core.js';

// FULL diff of one branch vs a base branch (merge-base → branch head, like a PR's "Files
// changed" view). `branch` and `base` are re-validated server-side against the repo's actual
// branch list — never an arbitrary revision from the client.
export async function GET({ url }) {
  const id = url.searchParams.get('id');
  const branch = url.searchParams.get('branch');
  const base = url.searchParams.get('base') || null;
  const root = url.searchParams.get('root') || null;
  const s = scanSessions().find((x) => x.id === id);
  const cwd = s ? s.project : null;
  if (!cwd || !branch) return json({ vcs: null, root: null, branch: null, base: null, mergeBase: null, merged: false, changes: [] });
  return json(await buildVcsBranchChanges(cwd, branch, base, root));
}
