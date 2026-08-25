import { json } from '@sveltejs/kit';
import { scanSessions, buildVcsCommitChanges } from '$lib/server/core.js';

// Diff d'UN commit (vs son parent) du dépôt principal du projet de la session (lentille Ship,
// mode VCS). `rev` vient de /api/session/vcs-log ; buildVcsCommitChanges le re-valide (hex
// uniquement — jamais passé brut à git/jj sans ce filtre).
export async function GET({ url }) {
  const id = url.searchParams.get('id');
  const rev = url.searchParams.get('rev') || '';
  const s = scanSessions().find((x) => x.id === id);
  const cwd = s ? s.project : null;
  if (!cwd) return json({ vcs: null, root: null, changes: [] });
  return json(await buildVcsCommitChanges(cwd, rev));
}
