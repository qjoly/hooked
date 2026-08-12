/*
 * Stream SSE du CONTENU COMPLET d'un fichier projet (≠ fileStream.js qui fait du tail append-only).
 * Chaque changement disque pousse tout le fichier → l'éditeur Monaco peut « suivre » un fichier
 * qu'un autre acteur (Claude Code) réécrit et l'écraser instantanément (Claude a la priorité).
 *
 * Mécanique reprise de fileStream.js : registre global (survit au HMR SSR), fs.watch + poll de
 * secours, dé-doublonnage par mtime. Le chemin est TOUJOURS résolu côté serveur par l'appelant
 * (resolveInRoot dans projectFiles.js) — jamais un chemin brut du client.
 *
 * Frame envoyée : event `change`, data = base64(JSON.stringify({ content, mtimeMs })). On encode
 * en base64 car le contenu contient des `\n` qui casseraient le cadrage SSE (une frame = une ligne).
 */
import fs from 'node:fs';

const g = globalThis;
const streams = (g.__hookedProjFileWatch ??= new Map()); // absPath -> état
const POLL_MS = 500;         // backstop si fs.watch rate un write
const DEBOUNCE_MS = 60;      // fs.watch émet en rafale → on regroupe
const MAX_BYTES = 2 * 1024 * 1024;

// Snapshot texte { content, mtimeMs } ou null (absent / binaire / trop gros).
function snapshot(file) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return null; }
  if (!st.isFile() || st.size > MAX_BYTES) return null;
  let buf;
  try { buf = fs.readFileSync(file); } catch (_) { return null; }
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return null; // binaire
  return { content: buf.toString('utf8'), mtimeMs: st.mtimeMs };
}

function frame(snap) {
  return Buffer.from(JSON.stringify(snap), 'utf8').toString('base64');
}

// Diffuse le fichier courant à tous les abonnés si son mtime a bougé (ou `force`).
function emit(st, force) {
  const snap = snapshot(st.file);
  if (!snap) return;
  if (!force && st.lastMtime === snap.mtimeMs) return;
  st.lastMtime = snap.mtimeMs;
  const data = frame(snap);
  for (const sub of st.subscribers) { try { sub('change', data); } catch (_) {} }
}

function startStream(file) {
  const st = { subscribers: new Set(), file, watcher: null, poll: null, lastMtime: -1, timer: null };
  const schedule = () => {
    if (st.timer) return;
    st.timer = setTimeout(() => { st.timer = null; emit(st, false); }, DEBOUNCE_MS);
    if (st.timer.unref) st.timer.unref();
  };
  try { st.watcher = fs.watch(file, schedule); } catch (_) {} // échoue si absent → le poll couvre
  st.poll = setInterval(() => emit(st, false), POLL_MS);
  if (st.poll.unref) st.poll.unref();
  streams.set(file, st);
  return st;
}

function stopStream(file) {
  const st = streams.get(file);
  if (!st) return;
  if (st.watcher) { try { st.watcher.close(); } catch (_) {} }
  if (st.poll) clearInterval(st.poll);
  if (st.timer) clearTimeout(st.timer);
  streams.delete(file); // on NE supprime jamais le fichier (il appartient au projet)
}

// Abonne un client SSE au contenu live d'un fichier. Amorce l'abonné avec le contenu courant
// (frame `change` immédiate → seed + résout la course GET/stream), puis pousse à chaque write.
function subscribeProjectFile(file, send) {
  if (typeof file !== 'string' || !file.startsWith('/')) { try { send('unavailable', ''); } catch (_) {} return () => {}; }
  let st = streams.get(file);
  if (!st) st = startStream(file);
  const snap = snapshot(file);
  if (snap) { st.lastMtime = snap.mtimeMs; try { send('change', frame(snap)); } catch (_) {} }
  st.subscribers.add(send);
  return () => {
    st.subscribers.delete(send);
    if (st.subscribers.size === 0) stopStream(file);
  };
}

export { subscribeProjectFile };
