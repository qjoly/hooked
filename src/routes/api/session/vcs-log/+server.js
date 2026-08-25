import { json } from '@sveltejs/kit';
import { scanSessions, listVcsCommits } from '$lib/server/core.js';

// Commits (git/jj) d'un dépôt du projet de la session — le principal par défaut, ou `root`
// (un des dépôts détectés, re-validé côté serveur). Alimente le sélecteur de commit de la
// lentille Ship (mode VCS). Lazy comme vcs-diff : jamais rappelé par le tick SSE.
export async function GET({ url }) {
  const id = url.searchParams.get('id');
  const root = url.searchParams.get('root') || null;
  const s = scanSessions().find((x) => x.id === id);
  const cwd = s ? s.project : null;
  if (!cwd) return json({ vcs: null, root: null, commits: [] });
  return json(await listVcsCommits(cwd, root));
}
