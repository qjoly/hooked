/*
 * Sauvegarde des images collées depuis le composer. Le serveur tournant sur la même machine
 * que les sessions tmux (100 % local), on décode le data-URL et on écrit le fichier sur disque.
 * Le composer envoie ensuite son chemin absolu dans le message : Claude Code lit les images
 * référencées par chemin (comme un drag-drop dans le TUI).
 */
import fs from 'node:fs';
import path from 'node:path';
import { HOOKED_DIR } from './config.js';

const IMAGES_DIR = path.join(HOOKED_DIR, 'images');
// types acceptés → extension de fichier
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function err400(msg) { const e = new Error(msg); e.code = 400; return e; }

// `dataUrl` : « data:image/png;base64,…. ». Renvoie { path, name } du fichier écrit.
function saveImage(dataUrl, cb) {
  if (typeof dataUrl !== 'string') return cb(err400('image invalide'));
  const m = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!m) return cb(err400('format d\'image non supporté (data-URL base64 attendu)'));
  const ext = EXT[m[1]];
  if (!ext) return cb(err400('type d\'image non supporté : ' + m[1]));
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch (_) { return cb(err400('base64 invalide')); }
  if (!buf.length) return cb(err400('image vide'));
  if (buf.length > 15 * 1024 * 1024) return cb(err400('image trop lourde (> 15 Mo)'));
  const name = `paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const fp = path.join(IMAGES_DIR, name);
  try {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    fs.writeFileSync(fp, buf);
  } catch (e) { return cb(new Error('écriture impossible : ' + (e.message || e))); }
  cb(null, { path: fp, name });
}

export { saveImage, IMAGES_DIR };
