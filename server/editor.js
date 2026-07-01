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

// Ouvre le sélecteur de dossier natif de l'OS (macOS uniquement) et renvoie le chemin choisi.
// Utilisé par « Other folder… » pour éviter la saisie manuelle d'un chemin.
function pickFolder(start, cb) {
  if (process.platform !== 'darwin') return cb(err400('native folder picker available on macOS only'));
  // `default location` seulement si `start` est un dossier valide (sinon AppleScript échoue).
  const loc = start && statSafe(start)?.isDirectory() ? ` default location (POSIX file ${JSON.stringify(start)})` : '';
  const expr = `POSIX path of (choose folder with prompt "Select a project folder"${loc})`;
  execFile('osascript', ['-e', expr], (err, stdout) => {
    // -128 = annulation utilisateur (clic sur Annuler) → pas une vraie erreur.
    if (err) {
      if (/-128|User canceled/i.test(String(err.message || err))) return cb(null, { canceled: true });
      return cb(new Error('folder picker failed: ' + err.message));
    }
    const dir = String(stdout).trim().replace(/\/+$/, '');
    if (!dir) return cb(null, { canceled: true });
    cb(null, { dir });
  });
}

export { openInVscode, openInGhostty, pickFolder };
