/*
 * Lecture / écriture d'un fichier du PROJET d'une session, pour l'éditeur Monaco (onglet IDE).
 *
 * Sécurité (modèle repris de vcsDiff.js / userFiles.js) : le seul intrant de confiance est le
 * `cwd` de la session (issu du transcript, PAS du client web). Tout chemin fourni par le client
 * est résolu PUIS vérifié comme vivant STRICTEMENT sous la racine projet (realpath → anti
 * path-traversal ET anti-symlink sortant). Le dev server peut écouter sur 0.0.0.0 : un endpoint
 * d'écriture de fichier arbitraire serait une surface d'attaque, d'où ce garde strict.
 *
 * On n'édite que des fichiers TEXTE déjà existants (pas de création via l'UI, pas de binaires),
 * avec un cap de taille.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scanSessions } from './transcript.js';

const MAX_BYTES = 2 * 1024 * 1024; // 2 Mo : cap lecture ET écriture

// Racine projet (realpath) de la session `id`, ou null.
function sessionRoot(id) {
  if (!id) return null;
  const s = scanSessions().find((x) => x.id === id);
  const dir = s && s.project;
  if (!dir) return null;
  try { return fs.realpathSync(dir); } catch (_) { return null; }
}

// Résout un chemin client (relatif à la racine, ou absolu) en un chemin absolu GARANTI sous
// `root`. Renvoie null à la moindre évasion. `mustExist` : le fichier lui-même est realpath
// (symlink-safe) ; sinon on realpath le dossier parent et on ré-attache le basename.
function resolveInRoot(root, p, { mustExist } = {}) {
  if (!root || typeof p !== 'string' || !p) return null;
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch (_) {
    if (mustExist) return null;
    try { real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); }
    catch (_2) { return null; }
  }
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (real !== root && !real.startsWith(withSep)) return null;
  return real;
}

// Heuristique binaire : un octet NUL dans les premiers Ko (comme vcsDiff.textOrNull).
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// { ok, path, rel, content, mtimeMs, binary } | { ok:false, error, binary?, tooLarge? }
function readProjectFile(id, p) {
  const root = sessionRoot(id);
  if (!root) return { ok: false, error: 'unknown session or project' };
  const real = resolveInRoot(root, p, { mustExist: true });
  if (!real) return { ok: false, error: 'path outside project' };
  let st;
  try { st = fs.statSync(real); } catch (_) { return { ok: false, error: 'not found' }; }
  if (!st.isFile()) return { ok: false, error: 'not a file' };
  if (st.size > MAX_BYTES) return { ok: false, error: 'file too large to edit', tooLarge: true };
  let buf;
  try { buf = fs.readFileSync(real); } catch (_) { return { ok: false, error: 'read failed' }; }
  if (looksBinary(buf)) return { ok: false, error: 'binary file — no editor', binary: true };
  return { ok: true, path: real, rel: path.relative(root, real), content: buf.toString('utf8'), mtimeMs: st.mtimeMs, binary: false };
}

// { ok, path, mtimeMs } | { ok:false, error }
function writeProjectFile(id, p, content) {
  const root = sessionRoot(id);
  if (!root) return { ok: false, error: 'unknown session or project' };
  if (typeof content !== 'string') return { ok: false, error: 'content must be a string' };
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) return { ok: false, error: 'content too large' };
  const real = resolveInRoot(root, p, { mustExist: true }); // on n'écrit que des fichiers existants
  if (!real) return { ok: false, error: 'path outside project or not found' };
  try { if (!fs.statSync(real).isFile()) return { ok: false, error: 'not a file' }; }
  catch (_) { return { ok: false, error: 'not found' }; }
  try { fs.writeFileSync(real, content, 'utf8'); }
  catch (e) { return { ok: false, error: 'write failed: ' + e.message }; }
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(real).mtimeMs; } catch (_) {}
  return { ok: true, path: real, mtimeMs };
}

export { readProjectFile, writeProjectFile, sessionRoot, resolveInRoot };
