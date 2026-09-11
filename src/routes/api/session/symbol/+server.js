import { json } from '@sveltejs/kit';
import { scanSessions, symbols } from '$lib/server/core.js';

// Déclaration(s) probables d'un symbole dans le dépôt du projet de la session — le back du
// « go to definition » (⌘-clic dans un diff de review). `file` est le chemin ABSOLU d'où part
// le clic : il sert au contexte de tri (localité, imports) et il est re-résolu côté serveur
// contre les dépôts DÉTECTÉS, jamais lu tel quel. `rev` vide = arbre de travail.
// Réponse : { supported, root, symbol, approximate, timedOut, truncated, origin, jump,
//             declarations, references, referenceCount }.
export async function GET({ url }) {
  const q = url.searchParams;
  const s = scanSessions().find((x) => x.id === q.get('id'));
  const cwd = s ? s.project : null;
  if (!cwd) return json({ supported: false, symbol: q.get('symbol') || '', jump: null, declarations: [], references: [] });
  return json(await symbols.lookup(cwd, {
    symbol: q.get('symbol') || '',
    file: q.get('file') || '',
    rev: q.get('rev') || '',
  }));
}
