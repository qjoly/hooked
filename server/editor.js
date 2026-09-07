/*
 * Ouverture du dossier projet d'une session dans un éditeur / terminal externe.
 */
import { execFile } from 'node:child_process';
import { statSafe } from './util.js';
import { scanSessions } from './transcript.js';
import { err400 } from './agent.js';
import { readSettings } from './settings.js';
import { editorFor } from '../src/lib/editors.js';

// Ouvre le dossier projet de la session `id` dans l'éditeur préféré (réglage `editor`, cf.
// src/lib/editors.js) via sa CLI — p.ex. `code -- <dir>` ou `zed <dir>`.
function openInEditor(id, cb) {
  if (!id) return cb(err400('id required'));
  const sess = scanSessions().find((x) => x.id === id);
  const dir = sess && sess.project;
  if (!dir) return cb(err400('project folder not found for this session'));
  const st = statSafe(dir);
  if (!st || !st.isDirectory()) return cb(err400('invalid project folder: ' + dir));
  const ed = editorFor(readSettings().editor);
  execFile(ed.cli, ed.cliArgs(dir), (err) => {
    if (err) return cb(new Error(`failed to open ${ed.label} (is the \`${ed.cli}\` CLI installed?): ` + err.message));
    cb(null, { dir, editor: ed.key });
  });
}

// Ouvre Ghostty sur le dossier projet de la session. (Avant la migration hors tmux, ce bouton
// rattachait la session tmux vivante — il n'y a plus de terminal à rattacher : la session est
// pilotée en processus par l'Agent SDK, et son fil de discussion vit dans le dashboard.)
function openInGhostty(id, cb) {
  if (!id) return cb(err400('id required'));
  const sess = scanSessions().find((x) => x.id === id);
  const dir = sess && sess.project;
  if (!dir) return cb(err400('project folder not found for this session'));
  const st = statSafe(dir);
  if (!st || !st.isDirectory()) return cb(err400('invalid project folder: ' + dir));

  // -na : nouvelle instance Ghostty ; --args transmet la config à l'app.
  // --window-save-state=never : empêche la restauration des anciennes fenêtres (sinon la
  // nouvelle instance recharge une session existante au lieu d'honorer --working-directory).
  const args = ['-na', 'Ghostty', '--args', '--window-save-state=never', `--working-directory=${dir}`];
  execFile('open', args, (err) => {
    if (err) return cb(new Error('failed to open Ghostty (installed?): ' + err.message));
    cb(null, { dir });
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

export { openInEditor, openInGhostty, pickFolder };
