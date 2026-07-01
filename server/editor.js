/*
 * Ouverture du dossier projet d'une session dans un éditeur / terminal externe.
 */
import { execFile } from 'node:child_process';
import { statSafe } from './util.js';
import { scanSessions } from './transcript.js';
import { paneForSession } from './events.js';
import { paneTmuxNames, tmuxAlive, err400 } from './tmux.js';

// Ouvre le dossier projet de la session `id` dans VS Code (`code <dir>`).
function openInVscode(id, cb) {
  if (!id) return cb(err400('id required'));
  const sess = scanSessions().find((x) => x.id === id);
  const dir = sess && sess.project;
  if (!dir) return cb(err400('project folder not found for this session'));
  const st = statSafe(dir);
  if (!st || !st.isDirectory()) return cb(err400('invalid project folder: ' + dir));
  execFile('code', ['--', dir], (err) => {
    if (err) return cb(new Error('failed to open VS Code (is the `code` CLI installed?): ' + err.message));
    cb(null, { dir });
  });
}

// Ouvre Ghostty sur la session : attache le tmux vivant si possible, sinon ouvre le dossier projet.
function openInGhostty(id, cb) {
  if (!id) return cb(err400('id required'));
  const sess = scanSessions().find((x) => x.id === id);
  const dir = sess && sess.project;
  if (!dir) return cb(err400('project folder not found for this session'));
  const st = statSafe(dir);
  if (!st || !st.isDirectory()) return cb(err400('invalid project folder: ' + dir));

  const pane = paneForSession(id);
  const tmuxName = pane && tmuxAlive(pane) ? paneTmuxNames().get(pane) : null;
  // -na : nouvelle instance Ghostty ; --args transmet la config à l'app.
  // --window-save-state=never : empêche la restauration des anciennes fenêtres (sinon la
  // nouvelle instance recharge une session existante au lieu d'honorer -e / --working-directory).
  const args = tmuxName
    ? ['-na', 'Ghostty', '--args', '--window-save-state=never', '-e', 'tmux', 'attach', '-t', tmuxName]
    : ['-na', 'Ghostty', '--args', '--window-save-state=never', `--working-directory=${dir}`];
  execFile('open', args, (err) => {
    if (err) return cb(new Error('failed to open Ghostty (installed?): ' + err.message));
    cb(null, { dir, attached: !!tmuxName });
  });
}

export { openInVscode, openInGhostty };
