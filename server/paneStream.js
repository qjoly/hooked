/*
 * Streaming « propre » d'un pane tmux (tier 2). On branche `tmux pipe-pane` sur le pane : tmux
 * écrit le FLUX D'OCTETS BRUT émis par le programme (avec ses vraies séquences d'échappement :
 * couleurs, déplacements curseur, effacements, redraws) dans un fichier. Le serveur tail ce
 * fichier et pousse les nouveaux octets en SSE ; le terminal web (xterm) les consomme tels quels
 * → vrai rendu temps réel, sans repeindre tout l'écran (contrairement au poll capture-pane).
 *
 * tmux fait office de PTY : aucune dépendance native (node-pty), seulement la lib standard.
 * Cycle de vie par pane, refcompté sur les abonnés SSE : ouverture du pipe au 1er abonné, snapshot
 * initial (capture-pane) pour amorcer l'écran, fermeture du pipe au dernier départ.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { HOOKED_DIR } from './config.js';
import { tmuxAlive } from './tmux.js';
import { capturePane } from './pane.js';

// Survit au hot-reload (Vite SSR/HMR) : un seul registre de streams pour tout le process.
const g = globalThis;
const streams = (g.__hookedPaneStreams ??= new Map()); // pane(%NN) → état du stream

// Lecture des octets ajoutés : sur macOS `fs.watch` sur un fichier en append est coalescé/peu
// fiable (FSEvents) → c'est ce poll rapide qui pilote réellement le redraw ET l'écho des frappes
// (l'écho revient par ce même chemin). On le veut donc court. Il ne fait QUE `readNew` (fstat + read,
// bon marché) — surtout PAS de commande tmux (spawn de process) à cette cadence.
const READ_POLL_MS = 33;
// Liveness (tmuxAlive) + changement de taille (checkSize) : chacun spawn un process tmux → cadence
// lente, séparée du poll de lecture pour ne pas multiplier les spawns.
const LIFECYCLE_POLL_MS = 700;
const ROTATE_BYTES = 2 * 1024 * 1024; // tronque le fichier de flux passé ce seuil (+ re-snapshot)

function streamFile(pane) {
  return path.join(HOOKED_DIR, 'panes', 'pane-' + pane.slice(1) + '.stream');
}

// Construit la frame d'amorçage de l'écran à partir d'un capture-pane. CRITIQUE : capture-pane
// sépare les lignes par un simple `\n` (lignes LOGIQUES, sans retour chariot ni info de wrap). On
// NE peut donc PAS recoller avec `\n` (escalier) ni avec `\r\n` (une ligne pleine largeur déclenche
// l'auto-wrap d'xterm PUIS le `\r\n` → saut de ligne en trop). On positionne donc chaque ligne en
// ABSOLU (`\x1b[<row>;1H`), ce qui aligne la grille xterm sur celle de tmux à l'octet près — sans
// quoi les éditions à curseur relatif (retour arrière, redraw du prompt) finissent par désynchroniser.
// `\x1b[0m` par ligne : évite que la couleur de fond de la ligne précédente « bave » sur la suivante.
function buildSnapshotFrame(c) {
  // Modes du terminal à re-synchroniser AVANT de peindre (le client a fait term.reset() → on part
  // des défauts xterm : écran normal, auto-wrap on, curseur applicatif off, keypad off, curseur
  // visible — on n'émet donc QUE les écarts). Indispensable pour les TUI plein écran rejoints en
  // cours (nvim, claude) : sans l'écran alterné et les touches curseur applicatives, l'affichage
  // et les flèches partent en vrille.
  let pre = '';
  if (c.altScreen) pre += '\x1b[?1049h';   // bascule écran alterné (le contenu y est peint)
  if (c.appCursor) pre += '\x1b[?1h';       // DECCKM on
  if (c.appKeypad) pre += '\x1b=';          // keypad applicatif on
  if (c.wrap === false) pre += '\x1b[?7l';  // auto-wrap off (défaut on)

  const lines = String(c.content || '').split('\n');
  let frame = pre + '\x1b[0m\x1b[H\x1b[2J';
  for (let i = 0; i < lines.length; i++) frame += `\x1b[${i + 1};1H\x1b[0m` + lines[i];
  // curseur placé en absolu là où tmux a le sien (lignes/colonnes 1-based).
  frame += `\x1b[${(c.cursorY || 0) + 1};${(c.cursorX || 0) + 1}H`;
  if (c.cursorVisible === false) frame += '\x1b[?25l';
  return frame;
}

// Envoie un snapshot (meta taille + écran courant) à UN abonné, puis l'enregistre comme abonné
// (dans cet ordre : garantit que le snapshot précède tout octet live pour cet abonné).
function sendSnapshot(pane, st, send) {
  capturePane(pane, (e, c) => {
    if (e || !c || !c.alive) { try { send('dead', ''); } catch (_) {} return; }
    try {
      send('meta', JSON.stringify({ width: c.width, height: c.height }));
      st.lastSize = c.width + ' ' + c.height;
      send('snapshot', Buffer.from(buildSnapshotFrame(c), 'utf8').toString('base64'));
    } catch (_) {}
    st.subscribers.add(send); // live à partir d'ici seulement
  });
}

// Lit les octets ajoutés depuis st.pos et les diffuse (base64) à tous les abonnés.
// SÉRIALISÉ : fs.watch ET le poll de secours appellent readNew, et l'I/O est async (open/fstat/
// read). Deux lectures concurrentes liraient depuis le MÊME st.pos puis l'avanceraient toutes les
// deux → octets dupliqués ET sautés (un `\x1b[J` de nettoyage sauté = lignes fantômes quand un TUI
// rétrécit). Le verrou `st.reading` garantit une seule lecture à la fois ; `pendingRead` relit si
// des octets sont arrivés pendant la lecture en cours.
function readNew(pane, st) {
  if (st.reading) { st.pendingRead = true; return; }
  st.reading = true;
  fs.open(st.file, 'r', (e, fd) => {
    if (e) return finishRead(pane, st);
    fs.fstat(fd, (e2, stt) => {
      if (e2 || stt.size <= st.pos) { fs.close(fd, () => {}); return finishRead(pane, st); }
      const len = stt.size - st.pos;
      const buf = Buffer.alloc(len);
      fs.read(fd, buf, 0, len, st.pos, (e3, n) => {
        fs.close(fd, () => {});
        if (!e3 && n) {
          st.pos += n;
          const b64 = buf.subarray(0, n).toString('base64');
          for (const sub of st.subscribers) { try { sub('data', b64); } catch (_) {} }
          if (st.pos > ROTATE_BYTES) rotate(pane, st);
        }
        finishRead(pane, st);
      });
    });
  });
}
// libère le verrou de lecture ; relance immédiatement si une lecture a été demandée entre-temps.
function finishRead(pane, st) {
  st.reading = false;
  if (st.pendingRead) { st.pendingRead = false; readNew(pane, st); }
}

// Tronque le fichier de flux et ré-amorce l'écran (évite la croissance illimitée sur un programme
// bavard). `cat >>` (O_APPEND) ré-écrit dès l'offset 0 après le truncate → on remet st.pos à 0.
function rotate(pane, st) {
  try { fs.truncateSync(st.file, 0); } catch (_) {}
  st.pos = 0;
  for (const sub of st.subscribers) sendSnapshotResync(pane, st, sub);
}
// re-snapshot vers un abonné DÉJÀ enregistré (ne le ré-ajoute pas).
function sendSnapshotResync(pane, st, send) {
  capturePane(pane, (e, c) => {
    if (e || !c || !c.alive) return;
    try { send('snapshot', Buffer.from(buildSnapshotFrame(c), 'utf8').toString('base64')); } catch (_) {}
  });
}

function startStream(pane) {
  const dir = path.join(HOOKED_DIR, 'panes');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const file = streamFile(pane);
  try { fs.writeFileSync(file, ''); } catch (_) {} // repart d'un flux vide
  const st = { subscribers: new Set(), file, pos: 0, watcher: null, poll: null, lifecycle: null, lastSize: '', reading: false, pendingRead: false };
  // branche le flux de sortie du pane vers le fichier (sortie = défaut de pipe-pane).
  execFile('tmux', ['pipe-pane', '-t', pane, `cat >> '${file}'`], () => {});
  try { st.watcher = fs.watch(file, () => readNew(pane, st)); } catch (_) {}
  // poll rapide : uniquement la lecture des octets (pas de spawn tmux).
  st.poll = setInterval(() => readNew(pane, st), READ_POLL_MS);
  // poll lent : liveness + taille (chacun spawn un process tmux).
  st.lifecycle = setInterval(() => {
    if (!tmuxAlive(pane)) { for (const sub of st.subscribers) { try { sub('dead', ''); } catch (_) {} } stopStream(pane); return; }
    checkSize(pane, st);
  }, LIFECYCLE_POLL_MS);
  if (st.poll.unref) st.poll.unref();
  if (st.lifecycle.unref) st.lifecycle.unref();
  streams.set(pane, st);
  return st;
}

// Détecte un changement de taille du pane → meta (xterm se redimensionne ; le programme redraw).
function checkSize(pane, st) {
  execFile('tmux', ['display-message', '-p', '-t', pane, '#{pane_width} #{pane_height}'], (e, o) => {
    if (e) return;
    const sz = String(o || '').trim();
    if (!sz || sz === st.lastSize) return;
    st.lastSize = sz;
    const [w, h] = sz.split(/\s+/).map(Number);
    for (const sub of st.subscribers) { try { sub('meta', JSON.stringify({ width: w, height: h })); } catch (_) {} }
  });
}

function stopStream(pane) {
  const st = streams.get(pane);
  if (!st) return;
  if (st.watcher) { try { st.watcher.close(); } catch (_) {} }
  if (st.poll) clearInterval(st.poll);
  if (st.lifecycle) clearInterval(st.lifecycle);
  execFile('tmux', ['pipe-pane', '-t', pane], () => {}); // sans commande → coupe le pipe
  try { fs.unlinkSync(st.file); } catch (_) {}
  streams.delete(pane);
}

// Abonne un client SSE au flux d'un pane. `send(event, data)` enquile une frame SSE. Renvoie une
// fonction de désinscription (coupe le pipe au dernier abonné).
function subscribePaneStream(pane, send) {
  if (!/^%\d+$/.test(pane || '')) { send('error', 'invalid pane'); return () => {}; }
  let st = streams.get(pane);
  if (!st) st = startStream(pane);
  sendSnapshot(pane, st, send); // ajoute aux abonnés après le snapshot (cf. sendSnapshot)
  return () => {
    st.subscribers.delete(send);
    if (st.subscribers.size === 0) stopStream(pane);
  };
}

export { subscribePaneStream };
