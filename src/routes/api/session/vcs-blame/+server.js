import { json } from '@sveltejs/kit';
import { scanSessions, buildVcsBlame } from '$lib/server/core.js';

// Blame d'un fichier d'un dépôt du projet de la session — « qui a écrit cette ligne ? » sous le
// curseur, dans les diffs (Ship / Branch). `file` est un chemin absolu, re-résolu côté serveur
// contre les dépôts DÉTECTÉS ; `rev` vide = arbre de travail (re-validé par buildVcsBlame).
export async function GET({ url }) {
  const id = url.searchParams.get('id');
  const file = url.searchParams.get('file') || '';
  const rev = url.searchParams.get('rev') || '';
  const s = scanSessions().find((x) => x.id === id);
  const cwd = s ? s.project : null;
  if (!cwd) return json({ supported: false, root: null, rev: null, commits: [], lines: [] });
  return json(await buildVcsBlame(cwd, file, rev));
}
