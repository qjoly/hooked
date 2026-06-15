import fs from 'node:fs';
import { json } from '@sveltejs/kit';
import { scanSessions, matchFiles, projectFiles } from '$lib/server/core.js';

// auto-complétion @ : fichiers du projet. cwd explicite (nouvelle session, pas encore
// d'id) prioritaire, sinon dérivé de la session ouverte.
export function GET({ url }) {
  const q = url.searchParams;
  let cwd = q.get('cwd') || null;
  if (!cwd) {
    const sess = scanSessions().find((x) => x.id === q.get('id'));
    cwd = sess && sess.project;
  }
  if (!cwd) return json({ files: [] });
  const st = fs.statSync(cwd, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return json({ files: [] });
  return json({ files: matchFiles(projectFiles(cwd), q.get('q') || '') });
}
