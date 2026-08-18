import { json } from '@sveltejs/kit';
import { scanSessions, buildVcsChanges } from '$lib/server/core.js';

// Diff du working tree (git ou jj) du projet de la session. Calcul à la demande (lazy) — pas dans
// sessionDetail, qui est repoussé à chaque tick SSE : on ne veut pas lancer `git diff` en boucle.
export async function GET({ url }) {
  const id = url.searchParams.get('id');
  const s = scanSessions().find((x) => x.id === id);
  const cwd = s ? s.project : null;
  if (!cwd) return json({ vcs: null, root: null, changes: [], truncated: false, repos: [] });
  return json(await buildVcsChanges(cwd));
}
