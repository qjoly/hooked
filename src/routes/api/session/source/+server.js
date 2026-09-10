import { json } from '@sveltejs/kit';
import { scanSessions, symbols } from '$lib/server/core.js';

// Tranche de lignes d'un fichier du projet, à une révision — ce que lit le panneau de
// définition quand la cible n'est pas dans la review. Sert des octets, donc durci : chemin
// absolu, realpath, et confinement aux dépôts détectés du cwd (cf. server/symbols.js).
// La fenêtre est bornée côté serveur : un panneau n'a jamais besoin de 20 000 lignes.
export async function GET({ url }) {
  const q = url.searchParams;
  const s = scanSessions().find((x) => x.id === q.get('id'));
  const cwd = s ? s.project : null;
  if (!cwd) return json({ supported: false, root: null, rel: null, lines: [] });
  return json(await symbols.readSlice(cwd, {
    file: q.get('file') || '',
    rev: q.get('rev') || '',
    from: Number(q.get('from')) || 0,
    to: Number(q.get('to')) || 0,
  }));
}
