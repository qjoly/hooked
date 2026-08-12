import { json } from '@sveltejs/kit';
import { sessionRoot, projectFiles } from '$lib/server/core.js';

// Liste PLATE de tous les fichiers du projet de la session (relatifs à la racine), pour la
// tree-view de l'IDE. Réutilise projectFiles() (cache 10 s, ignore node_modules/.git/dossiers
// cachés, cap 5000). La racine est résolue côté serveur depuis le transcript — jamais du client.
export function GET({ url }) {
  const root = sessionRoot(url.searchParams.get('id'));
  if (!root) return json({ ok: false, files: [] });
  return json({ ok: true, files: projectFiles(root) });
}
