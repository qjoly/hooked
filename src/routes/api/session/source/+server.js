import path from 'node:path';
import { json } from '@sveltejs/kit';
import { scanSessions, symbols, buildFileChanges } from '$lib/server/core.js';

// Tranche de lignes d'un fichier du projet, à une révision — ce que lit le panneau de
// définition quand la cible n'est pas dans la review. Sert des octets, donc durci : chemin
// absolu, realpath, et confinement aux dépôts détectés du cwd (cf. server/symbols.js).
// La fenêtre est bornée côté serveur : un panneau n'a jamais besoin de 20 000 lignes.
export async function GET({ url }) {
  const q = url.searchParams;
  const s = scanSessions().find((x) => x.id === q.get('id'));
  const cwd = s ? s.project : null;
  if (!cwd) return json({ supported: false, root: null, rel: null, lines: [] });
  const file = q.get('file') || '';
  const opts = { file, rev: q.get('rev') || '', from: Number(q.get('from')) || 0, to: Number(q.get('to')) || 0 };
  const r = await symbols.readSlice(cwd, opts);
  // Claude also edits files outside the session's repos (the Review lens lists them): those are
  // allowed through the same allowlist as /api/session/file-changes, resolved from their own repo.
  // ponytail: still needs the file to live in a git repo, read it off disk directly if that bites.
  if (r.supported || !s.file || !buildFileChanges(s.file, s.id).some((c) => c.file === file)) return json(r);
  return json(await symbols.readSlice(path.dirname(file), opts));
}
