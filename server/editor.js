/*
 * Ouverture du dossier projet d'une session dans VS Code via la CLI `code`.
 */
import { execFile } from 'node:child_process';
import { statSafe } from './util.js';
import { scanSessions } from './transcript.js';
import { err400 } from './tmux.js';

// Ouvre le dossier projet de la session `id` dans VS Code (`code <dir>`).
function openInVscode(id, cb) {
  if (!id) return cb(err400('id requis'));
  const sess = scanSessions().find((x) => x.id === id);
  const dir = sess && sess.project;
  if (!dir) return cb(err400('dossier projet introuvable pour cette session'));
  const st = statSafe(dir);
  if (!st || !st.isDirectory()) return cb(err400('dossier projet invalide : ' + dir));
  execFile('code', ['--', dir], (err) => {
    if (err) return cb(new Error('échec ouverture VS Code (CLI `code` installée ?) : ' + err.message));
    cb(null, { dir });
  });
}

export { openInVscode };
