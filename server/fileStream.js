/*
 * Streaming SSE d'un FICHIER TEXTE en append (tail -f) — même mécanique que paneStream.js
 * (fs.watch + poll de secours + lecture SÉRIALISÉE depuis un offset partagé), mais pour un
 * fichier ordinaire au lieu d'un pane tmux. Sert à suivre en direct le `.output` d'un job de
 * fond Bash (run_in_background). On n'écrit ni ne supprime le fichier (il appartient au harnais
 * Claude Code) — on ne fait que le lire.
 *
 * IMPORTANT sécurité : ce module streame le chemin qu'on lui donne. La RÉSOLUTION du chemin
 * (session + taskId → .output) est faite côté serveur par l'appelant (cf. resolveBackgroundOutput
 * dans stats.js) ; on n'accepte jamais un chemin fourni par le client.
 */
import fs from 'node:fs';

// Survit au hot-reload (Vite SSR/HMR) : un seul registre pour tout le process.
const g = globalThis;
const streams = (g.__hookedFileStreams ??= new Map()); // absPath -> état du stream

const SAFETY_POLL_MS = 400;          // backstop si fs.watch rate un append
const SEED_MAX = 256 * 1024;         // amorçage : au plus les derniers 256 Ko du fichier

// Lit les octets ajoutés depuis st.pos et les diffuse (base64) à tous les abonnés. SÉRIALISÉ
// (fs.watch ET le poll appellent readNew) : deux lectures concurrentes liraient depuis le même
// st.pos → octets dupliqués/sautés. Verrou `reading` + `pendingRead` (cf. paneStream.js).
function readNew(st) {
  if (st.reading) { st.pendingRead = true; return; }
  st.reading = true;
  fs.open(st.file, 'r', (e, fd) => {
    if (e) return finishRead(st); // fichier pas encore créé → on réessaiera au prochain tick
    fs.fstat(fd, (e2, stt) => {
      if (e2) { fs.close(fd, () => {}); return finishRead(st); }
      if (stt.size < st.pos) st.pos = 0; // fichier tronqué/recréé → on repart du début
      if (stt.size <= st.pos) { fs.close(fd, () => {}); return finishRead(st); }
      const len = stt.size - st.pos;
      const buf = Buffer.alloc(len);
      fs.read(fd, buf, 0, len, st.pos, (e3, n) => {
        fs.close(fd, () => {});
        if (!e3 && n) {
          st.pos += n;
          const b64 = buf.subarray(0, n).toString('base64');
          for (const sub of st.subscribers) { try { sub('data', b64); } catch (_) {} }
        }
        finishRead(st);
      });
    });
  });
}
function finishRead(st) {
  st.reading = false;
  if (st.pendingRead) { st.pendingRead = false; readNew(st); }
}

function startStream(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch (_) {} // le fichier peut ne pas exister encore
  const st = { subscribers: new Set(), file, pos: size, watcher: null, poll: null, reading: false, pendingRead: false };
  try { st.watcher = fs.watch(file, () => readNew(st)); } catch (_) {} // échoue si absent → le poll couvre
  st.poll = setInterval(() => readNew(st), SAFETY_POLL_MS);
  if (st.poll.unref) st.poll.unref();
  streams.set(file, st);
  return st;
}

function stopStream(file) {
  const st = streams.get(file);
  if (!st) return;
  if (st.watcher) { try { st.watcher.close(); } catch (_) {} }
  if (st.poll) clearInterval(st.poll);
  streams.delete(file); // on NE supprime PAS le fichier (il ne nous appartient pas)
}

// Amorce UN abonné avec la queue actuelle du fichier ([st.pos-SEED_MAX, st.pos)), puis l'enregistre
// (dans cet ordre : le seed précède tout octet live). Un abonné tardif reçoit un historique récent
// cohérent, puis le live à partir de st.pos → ni trou ni doublon.
function seed(st, send) {
  const end = st.pos;
  const start = Math.max(0, end - SEED_MAX);
  if (end <= start) { try { send('seed', ''); } catch (_) {} st.subscribers.add(send); return; }
  fs.open(st.file, 'r', (e, fd) => {
    if (e) { try { send('seed', ''); } catch (_) {} st.subscribers.add(send); return; }
    const len = end - start;
    const buf = Buffer.alloc(len);
    fs.read(fd, buf, 0, len, start, (e2, n) => {
      fs.close(fd, () => {});
      try { send('seed', (!e2 && n) ? buf.subarray(0, n).toString('base64') : ''); } catch (_) {}
      st.subscribers.add(send);
    });
  });
}

// Abonne un client SSE au tail d'un fichier. `send(event, data)` enqueue une frame SSE :
//   seed (queue initiale, base64) puis data (octets ajoutés, base64). Renvoie la désinscription.
function subscribeFileStream(file, send) {
  if (typeof file !== 'string' || !file.startsWith('/')) { try { send('unavailable', ''); } catch (_) {} return () => {}; }
  let st = streams.get(file);
  if (!st) st = startStream(file);
  seed(st, send);
  return () => {
    st.subscribers.delete(send);
    if (st.subscribers.size === 0) stopStream(file);
  };
}

export { subscribeFileStream };
