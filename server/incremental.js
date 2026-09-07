/*
 * Lecteur de fichier INCRÉMENTAL et caché — le socle des lectures de transcripts chaudes
 * (scanSessions, latestTodos, buildBackgroundJobs), toutes appelées pour CHAQUE session à
 * CHAQUE poll de /api/sessions (~5 s).
 *
 * Les transcripts .jsonl de Claude Code sont APPEND-ONLY et grandissent : une session active
 * ajoute quelques lignes à chaque poll. L'ancien schéma (cache par mtime:size, mais relecture +
 * reparse du fichier ENTIER au moindre changement) refait donc un travail O(taille du fichier)
 * sur les grosses sessions actives à chaque poll — c'était le gel résiduel de l'event loop
 * (~80 ms par consommateur sur un transcript de 24 Mo). Ici on garde un accumulateur entre deux
 * polls et on ne replie QUE les octets ajoutés → O(octets ajoutés).
 *
 * Chaque consommateur fournit init()/fold(acc, line)/finalize(acc) ; le lecteur gère le cache,
 * l'offset d'octets, la détection de troncature/rotation et la frontière de ligne.
 *
 * FRONTIÈRE : on ne VALIDE (et n'avance l'offset) que jusqu'au dernier '\n'. Une ligne partielle
 * en fin de fichier (écriture en cours) n'est pas repliée → elle le sera une fois complète, sans
 * double-comptage. L'offset pointant toujours juste après un '\n' (octet 0x0A, jamais un fragment
 * de séquence multi-octets) est une frontière utf8 sûre.
 *
 * REPLI COMPLET (secours) sur tout cas non append-only : fichier neuf, tronqué (size < offset),
 * roté (inode changé) ou réécrit sur place (même taille, mtime différent).
 */
import fs from 'node:fs';
import { statSafe } from './util.js';

// Lit la plage d'octets [start, end) du fichier en Buffer brut. Le découpage utf8/lignes est fait
// par l'appelant, borné à une frontière de '\n' (donc jamais de multi-octets tronqué).
function readRange(fp, start, end) {
  const len = end - start;
  if (len <= 0) return Buffer.alloc(0);
  let fd;
  try {
    fd = fs.openSync(fp, 'r');
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return n === len ? buf : buf.subarray(0, n);
  } catch (_) { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Replie les lignes complètes (jusqu'au dernier '\n') d'un buffer dans acc. Retourne le nombre
// d'octets validés (0 si aucun '\n' → tout le buffer est une ligne partielle en attente).
function foldCommitted(buf, acc, fold) {
  const nl = buf.lastIndexOf(0x0a);
  if (nl < 0) return 0;
  const text = buf.toString('utf8', 0, nl + 1);
  for (const line of text.split('\n')) fold(acc, line);
  return nl + 1;
}

// Construit un lecteur mémoïsé et incrémental. `init(fp, ...args)` crée un accumulateur neuf ;
// `fold(acc, line)` replie une ligne validée ; `finalize(acc)` en dérive la valeur retournée.
// `empty` est retourné quand le fichier est absent/illisible. Les args supplémentaires passés à
// read() sont transmis à init() (p. ex. le sessionId d'un transcript).
function incrementalReader({ init, fold, finalize, empty = null }) {
  const cache = new Map(); // path -> { ino, size, mtimeMs, offset, acc, value }
  return function read(fp, ...args) {
    const st = fp ? statSafe(fp) : null;
    if (!st) return empty;
    const cached = cache.get(fp);
    // inchangé → même valeur (chemin le plus fréquent : sessions dormantes)
    if (cached && cached.ino === st.ino && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
      return cached.value;
    }
    // a grandi, même fichier, offset dans les bornes → repli des SEULS octets ajoutés
    if (cached && cached.ino === st.ino && st.size >= cached.offset && st.size > cached.size) {
      const buf = readRange(fp, cached.offset, st.size);
      if (buf) {
        cached.offset += foldCommitted(buf, cached.acc, fold);
        cached.size = st.size;
        cached.mtimeMs = st.mtimeMs;
        cached.value = finalize(cached.acc);
        return cached.value;
      }
    }
    // repli complet (fichier neuf, tronqué, roté, réécrit, ou lecture partielle en échec)
    let buf;
    try { buf = fs.readFileSync(fp); } catch (_) { return empty; }
    const acc = init(fp, ...args);
    const committed = foldCommitted(buf, acc, fold);
    const value = finalize(acc);
    cache.set(fp, { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, offset: committed, acc, value });
    return value;
  };
}

export { incrementalReader };
