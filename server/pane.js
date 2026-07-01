/*
 * Panes « show » : un agent (via le MCP show_in_pane) demande à exécuter une commande dans un
 * NOUVEAU pane (split) ou une NOUVELLE fenêtre du MÊME tmux que la session Claude Code suivie —
 * pour montrer quelque chose à l'utilisateur (serveur de dev, htop, démo…). Le pane créé est
 * mémorisé (panes.jsonl) pour être mirroré en lecture seule dans l'UI web (onglet Terminal),
 * via `tmux capture-pane`.
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { SHOWN_PANES_FILE } from './config.js';
import { statSafe } from './util.js';
import { paneForSession } from './events.js';
import { tmuxAlive, invalidatePaneCache, paneTmuxNames, err400 } from './tmux.js';
import { scanSessions } from './transcript.js';
import { readSettings } from './settings.js';

// délai avant de « taper » la commande dans le nouveau pane (laisser le shell démarrer), puis
// avant l'Entrée de validation — même piège de détection de collage que tmux.deliverReply.
const CMD_DELAY = 350;

// Ouvre un nouveau pane (split, défaut) ou une nouvelle fenêtre dans le tmux de la session `id`,
// y lance `command`, et mémorise le pane créé pour le mirroir UI. Le pane démarre sur le shell
// par défaut de tmux (PATH du login), puis la commande y est « tapée » (send-keys -l) — comme
// launchSession, ce qui évite tout souci d'échappement/injection (jamais interpolée dans un shell)
// et laisse le pane interactif après l'exécution (l'utilisateur peut Ctrl-C, relancer, etc.).
function showInPane(id, { command, target } = {}, cb) {
  if (!id) return cb(err400('id required'));
  // command optionnelle : sans elle (bouton « ＋ Pane »), on retombe sur la commande shell
  // initiale configurée dans les réglages (vide → pane shell nu).
  const fallback = readSettings().initialShellCommand;
  const cmd = (typeof command === 'string' && command.trim()) ? command
    : (fallback && fallback.trim() ? fallback : null);
  // DÉFAUT = window (nouvelle fenêtre tmux pleine taille). Un split partagerait la fenêtre : chaque
  // pane n'aurait qu'une fraction de la hauteur, et le mode Adapter (resize-window) gonflerait la
  // FENÊTRE mais pas le pane individuel → gros vide sous le programme + le pane Claude rétréci.
  // Une fenêtre dédiée se redimensionne en plein pour remplir la vue web. `pane` reste possible.
  const where = target === 'pane' ? 'pane' : 'window';
  const pane = paneForSession(id);
  if (!pane) return cb(err400('unknown tmux pane for this session (launched outside tmux?)'));
  if (!tmuxAlive(pane)) return cb(err400('session tmux closed: cannot open a pane'));

  const sess = scanSessions().find((x) => x.id === id);
  const dir = sess && sess.project;
  // split-window se cible sur le pane (il le coupe en deux) ; new-window se cible sur la SESSION
  // tmux (préciser un pane échoue : « can't specify pane here »). On résout le nom de session via
  // le cache pane→nom (déjà chaud, tmuxAlive vient d'y accéder) ; sinon on retombe sur un split.
  let sub = where === 'window' ? 'new-window' : 'split-window';
  let tmuxTarget = pane;
  if (sub === 'new-window') {
    const sessName = paneTmuxNames().get(pane);
    // suffixe ':' → cible la SESSION (sinon un nom numérique comme « 0 » est lu comme un index
    // de fenêtre → « index 0 in use »). La fenêtre est créée au prochain index libre.
    if (sessName) tmuxTarget = sessName + ':';
    else sub = 'split-window'; // nom de session introuvable : split par défaut
  }
  // -P -F '#{pane_id}' : imprime l'id (%NN) du pane/fenêtre créé, indispensable pour le mirroir.
  const args = [sub, '-P', '-F', '#{pane_id}', '-t', tmuxTarget];
  if (dir && statSafe(dir) && statSafe(dir).isDirectory()) args.push('-c', dir);

  execFile('tmux', args, (e, out) => {
    if (e) return cb(new Error(`tmux ${sub} failed: ` + (e.message || e)));
    const newPane = String(out).trim();
    if (!/^%\d+$/.test(newPane)) return cb(new Error('created pane not identified: ' + newPane));
    invalidatePaneCache(); // le pane tout neuf doit être « vu » vivant tout de suite (UI)
    try {
      fs.appendFileSync(SHOWN_PANES_FILE, JSON.stringify({ ts: new Date().toISOString(), session_id: id, pane: newPane, target: where, command: cmd ? cmd.slice(0, 500) : '' }) + '\n');
    } catch (_) {}
    // tape la commande puis Entrée (best-effort, après démarrage du shell) — uniquement si fournie.
    if (cmd) {
      setTimeout(() => execFile('tmux', ['send-keys', '-t', newPane, '-l', '--', cmd], () => {
        setTimeout(() => execFile('tmux', ['send-keys', '-t', newPane, 'Enter'], () => {}), CMD_DELAY);
      }), CMD_DELAY);
    }
    cb(null, { pane: newPane, source: pane, target: where, command: cmd });
  });
}

// Ferme un pane « show » (le bouton ✕ de l'UI) : tue le pane tmux. shownPanesFor le filtrera
// (tmuxAlive faux) au prochain rafraîchissement → il disparaît de l'onglet.
function killPane(pane, cb) {
  if (!/^%\d+$/.test(pane || '')) return cb(err400('invalid pane'));
  execFile('tmux', ['kill-pane', '-t', pane], (e) => {
    if (e) return cb(new Error('kill-pane failed: ' + (e.message || e)));
    invalidatePaneCache();
    cb(null, { pane });
  });
}

// Envoie une saisie clavier (input interactif) à un pane « show ». `data` est le flux d'octets
// produit par le terminal côté navigateur (xterm.onData : texte, mais aussi séquences d'échappement
// pour les flèches/F-keys et octets de contrôle pour Ctrl-C, Échap…). On le transmet TEL QUEL au
// tty du pane via `send-keys -H` (hexadécimal) : `-H` forwarde des octets bruts sans interprétation
// de noms de touches et gère proprement les octets de contrôle (impossibles à passer en argv via -l,
// ex. NUL). Le pane partage son entrée avec un éventuel client tmux attaché — comportement attendu.
function sendInput(pane, data, cb) {
  if (!/^%\d+$/.test(pane || '')) return cb(err400('invalid pane'));
  if (typeof data !== 'string' || !data.length) return cb(err400('data required'));
  if (!tmuxAlive(pane)) return cb(err400('pane closed'));
  // octets → paires hex ; les caractères non-ASCII (UTF-8 multioctets) sont décomposés en octets.
  const hex = Buffer.from(data, 'utf8').toString('hex').match(/../g) || [];
  if (!hex.length) return cb(null, { pane });
  execFile('tmux', ['send-keys', '-t', pane, '-H', ...hex], (e) => {
    if (e) return cb(new Error('send-keys failed: ' + (e.message || e)));
    cb(null, { pane });
  });
}

// Redimensionne la FENÊTRE tmux du pane (donc le pane plein écran) pour épouser la place dispo
// dans la fenêtre web. `resize-window` bascule la fenêtre en window-size=manual (elle ne suit plus
// les clients tmux attachés) — d'où le mode `auto` qui restaure `window-size latest` quand la vue
// web se ferme, pour que rattacher dans un vrai terminal (Ghostty) reflue normalement.
function resizePane(pane, { cols, rows, auto } = {}, cb) {
  if (!/^%\d+$/.test(pane || '')) return cb(err400('invalid pane'));
  if (!tmuxAlive(pane)) return cb(err400('pane closed'));
  if (auto) {
    return execFile('tmux', ['set-option', '-w', '-t', pane, 'window-size', 'latest'], (e) => {
      if (e) return cb(new Error('set window-size: ' + (e.message || e)));
      cb(null, { pane, auto: true });
    });
  }
  const c = Math.max(20, Math.min(500, parseInt(cols, 10) || 0));
  const r = Math.max(5, Math.min(300, parseInt(rows, 10) || 0));
  execFile('tmux', ['resize-window', '-t', pane, '-x', String(c), '-y', String(r)], (e) => {
    if (e) return cb(new Error('resize-window: ' + (e.message || e)));
    cb(null, { pane, cols: c, rows: r });
  });
}

// Capture l'écran courant d'un pane tmux (mirroir lecture seule). `-e` conserve les séquences
// d'échappement (couleurs) pour un rendu fidèle côté xterm.js ; on renvoie aussi les dimensions
// du pane pour que le terminal web s'y ajuste (wrapping identique à tmux).
function capturePane(pane, cb) {
  if (!/^%\d+$/.test(pane || '')) return cb(err400('invalid pane'));
  if (!tmuxAlive(pane)) return cb(null, { alive: false, width: 0, height: 0, cursorX: 0, cursorY: 0, content: '' });
  // dimensions + curseur + ÉTAT DES MODES du terminal du pane, en un seul appel. capture-pane ne
  // rend que les cellules visibles : il manque le positionnement du curseur ET les modes que le
  // programme a posés à son démarrage (écran alterné, touches curseur applicatives, auto-wrap,
  // visibilité du curseur). Sans ces modes, un TUI rejoint en cours de route (nvim, claude…) se
  // désynchronise de xterm → flèches qui envoient les mauvaises séquences, redraws cassés. tmux
  // expose ces modes en variables de format → on les rejoue dans le snapshot (cf. paneStream).
  const fmt = '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{alternate_on} #{cursor_flag} #{keypad_cursor_flag} #{keypad_flag} #{wrap_flag}';
  execFile('tmux', ['display-message', '-p', '-t', pane, fmt], (e1, info) => {
    const n = String(info || '').trim().split(/\s+/).map((x) => parseInt(x, 10));
    execFile('tmux', ['capture-pane', '-p', '-e', '-t', pane], (e2, out) => {
      if (e2) return cb(new Error('capture-pane failed: ' + (e2.message || e2)));
      cb(null, {
        alive: true,
        width: n[0] || 80, height: n[1] || 24,
        cursorX: n[2] || 0, cursorY: n[3] || 0,
        altScreen: n[4] === 1,        // écran alterné (smcup) — vim/htop/claude plein écran
        cursorVisible: n[5] !== 0,    // cursor_flag (défaut visible)
        appCursor: n[6] === 1,        // DECCKM : flèches en mode applicatif (\x1bOA…)
        appKeypad: n[7] === 1,        // keypad applicatif
        wrap: n[8] !== 0,             // auto-wrap (DECAWM, défaut on)
        content: out || '',
      });
    });
  });
}

// Panes « show » encore vivants pour une session (dernière entrée par pane gagne), pour l'UI.
// Cache léger invalidé par mtime/size, comme les autres lecteurs de jsonl.
let shownCache = { key: null, byId: new Map() };
function shownPanesFor(id) {
  const st = statSafe(SHOWN_PANES_FILE);
  if (!st) return [];
  const key = st.mtimeMs + ':' + st.size;
  if (shownCache.key !== key) {
    const byId = new Map(); // session_id → Map(pane → entry)
    let data = '';
    try { data = fs.readFileSync(SHOWN_PANES_FILE, 'utf8'); } catch (_) { return (shownCache.byId.get(id) ? aliveOnly(shownCache.byId.get(id)) : []); }
    for (const line of data.split('\n')) {
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (!j.session_id || !j.pane) continue;
        const map = byId.get(j.session_id) || new Map();
        map.set(j.pane, { pane: j.pane, command: j.command || '', target: j.target || 'pane', ts: j.ts });
        byId.set(j.session_id, map);
      } catch (_) {}
    }
    shownCache = { key, byId };
  }
  const map = shownCache.byId.get(id);
  return map ? aliveOnly(map) : [];
}
function aliveOnly(map) {
  const out = [];
  for (const e of map.values()) if (tmuxAlive(e.pane)) out.push(e);
  return out;
}

export { showInPane, killPane, capturePane, sendInput, resizePane, shownPanesFor };
