/*
 * Sauvegarde des images collées depuis le composer. Le serveur tournant sur la même machine
 * que les sessions pilotées par hooked (100 % local), on décode le data-URL et on écrit le fichier
 * sur disque.
 * Le composer envoie ensuite son chemin absolu dans le message : Claude Code lit les images
 * référencées par chemin (comme un drag-drop dans le TUI).
 */
import fs from 'node:fs';
import path from 'node:path';
import { HOOKED_DIR } from './config.js';

const IMAGES_DIR = path.join(HOOKED_DIR, 'images');
// types acceptés → extension de fichier
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
// extension de fichier → content-type (pour servir les images au navigateur)
const CONTENT_TYPE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function err400(msg) { const e = new Error(msg); e.code = 400; return e; }

// `dataUrl` : « data:image/png;base64,…. ». Renvoie { path, name } du fichier écrit.
function saveImage(dataUrl, cb) {
  if (typeof dataUrl !== 'string') return cb(err400('invalid image'));
  const m = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!m) return cb(err400('unsupported image format (base64 data-URL expected)'));
  const ext = EXT[m[1]];
  if (!ext) return cb(err400('unsupported image type: ' + m[1]));
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch (_) { return cb(err400('invalid base64')); }
  if (!buf.length) return cb(err400('empty image'));
  if (buf.length > 15 * 1024 * 1024) return cb(err400('image too large (> 15 MB)'));
  const name = `paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const fp = path.join(IMAGES_DIR, name);
  try {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    fs.writeFileSync(fp, buf);
  } catch (e) { return cb(new Error('write failed: ' + (e.message || e))); }
  cb(null, { path: fp, name });
}

// Lit une image POUR L'AFFICHER dans l'UI web. Restreinte au dossier IMAGES_DIR : le dev server peut
// écouter sur 0.0.0.0, donc jamais de lecture de fichier arbitraire (path traversal / symlink hors
// dossier bloqués via realpath). Renvoie { buffer, contentType } ou null (introuvable / hors dossier
// / type non image). Les noms sont uniques et immuables → le cache HTTP long est sûr côté route.
function readImage(absPath) {
  if (typeof absPath !== 'string' || !absPath) return null;
  let baseReal, real;
  try {
    baseReal = fs.realpathSync(IMAGES_DIR);
    real = fs.realpathSync(absPath);
  } catch (_) { return null; }
  if (real !== baseReal && !real.startsWith(baseReal + path.sep)) return null; // hors IMAGES_DIR
  const contentType = CONTENT_TYPE[path.extname(real).toLowerCase()];
  if (!contentType) return null;
  let st;
  try { st = fs.statSync(real); } catch (_) { return null; }
  if (!st.isFile()) return null;
  let buffer;
  try { buffer = fs.readFileSync(real); } catch (_) { return null; }
  return { buffer, contentType };
}

export { saveImage, readImage, IMAGES_DIR };
