import { json } from '@sveltejs/kit';
import { scanSessions, listVcsCommits } from '$lib/server/core.js';

// Commits (git/jj) du dépôt principal du projet de la session — alimente le sélecteur de commit
// de la lentille Ship (mode VCS). Lazy comme vcs-diff : jamais rappelé par le tick SSE.
export async function GET({ url }) {
  const id = url.searchParams.get('id');
  const s = scanSessions().find((x) => x.id === id);
  const cwd = s ? s.project : null;
  if (!cwd) return json({ vcs: null, root: null, commits: [] });
  return json(await listVcsCommits(cwd));
}
