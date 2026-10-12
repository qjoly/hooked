/*
 * Sert un fichier envoyé à l'utilisateur via l'outil SendUserFile, POUR l'afficher dans la
 * conversation web (miniature image / lien d'ouverture). Le dev server pouvant écouter sur
 * 0.0.0.0, on ne lit JAMAIS un chemin arbitraire fourni par le client : on reconstruit la liste
 * blanche des chemins depuis le transcript lui-même (les blocs SendUserFile de CETTE session /
 * de CE sous-agent) et on ne sert que ceux-là (realpath, anti path-traversal / symlink).
 * Les fichiers HTML/SVG sont forcés en pièce jointe (jamais rendus inline same-origin → pas
 * d'exécution de script contre l'origine hooked).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './config.js';
import { readdirSafe, statSafe, SHOW_TOOLS } from './util.js';
import { agentTranscriptPath } from './transcript.js';

const CONTENT_TYPE = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};
// jamais rendus inline same-origin (SVG/HTML peuvent porter du script exécuté contre l'origine)
const FORCE_ATTACHMENT = new Set(['.html', '.htm', '.svg']);
const MAX_BYTES = 50 * 1024 * 1024;

// localise le transcript principal d'une session à partir de son id (miroir de agentTranscriptPath).
function sessionTranscriptPath(sessionId, projectsDir = PROJECTS_DIR) {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId || '')) return null;
  for (const proj of readdirSafe(projectsDir)) {
    const cand = path.join(projectsDir, proj, sessionId + '.jsonl');
    const st = statSafe(cand);
    if (st && st.isFile()) return cand;
  }
  return null;
}

// Files a tool_use hands to the user: SendUserFile's `files`, show_image/show_video's `path` and
// `compare` (the before side).
function sentPaths(b) {
  const i = b.input || {};
  if (b.name === 'SendUserFile') return Array.isArray(i.files) ? i.files : [];
  if (SHOW_TOOLS[b.name]) return [i.path, i.compare];
  return [];
}

// Ensemble des chemins (realpath) réellement envoyés via SendUserFile dans ce transcript.
// Les relatifs sont résolus contre le `cwd` de la ligne du tool_use.
function collectAllowlist(fp) {
  const set = new Set();
  let data;
  try { data = fs.readFileSync(fp, 'utf8'); } catch (_) { return set; }
  for (const line of data.split('\n')) {
    if (!line || (line.indexOf('SendUserFile') === -1 && line.indexOf('mcp__hooked__show_') === -1)) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    const c = j && j.message && j.message.content;
    if (!Array.isArray(c)) continue;
    const cwd = typeof j.cwd === 'string' ? j.cwd : '';
    for (const b of c) {
      if (!b || b.type !== 'tool_use') continue;
      for (const f of sentPaths(b)) {
        if (typeof f !== 'string' || !f) continue;
        const abs = path.isAbsolute(f) ? f : (cwd ? path.resolve(cwd, f) : null);
        if (!abs) continue;
        try { set.add(fs.realpathSync(abs)); } catch (_) { /* fichier disparu → non servable */ }
      }
    }
  }
  return set;
}

// Lit un fichier SendUserFile pour l'UI. `agentId` non vide → transcript du sous-agent.
// Renvoie { buffer, contentType, attachment, name } ou null (introuvable / hors liste blanche).
function readUserFile(sessionId, agentId, absPath, projectsDir = PROJECTS_DIR) {
  if (typeof absPath !== 'string' || !absPath) return null;
  const fp = agentId ? agentTranscriptPath(sessionId, agentId, projectsDir) : sessionTranscriptPath(sessionId, projectsDir);
  if (!fp) return null;
  let real;
  try { real = fs.realpathSync(absPath); } catch (_) { return null; }
  if (!collectAllowlist(fp).has(real)) return null; // jamais envoyé par cette session → 404
  let st;
  try { st = fs.statSync(real); } catch (_) { return null; }
  if (!st.isFile() || st.size > MAX_BYTES) return null;
  const ext = path.extname(real).toLowerCase();
  const contentType = CONTENT_TYPE[ext] || 'application/octet-stream';
  const attachment = FORCE_ATTACHMENT.has(ext) || contentType === 'application/octet-stream';
  let buffer;
  try { buffer = fs.readFileSync(real); } catch (_) { return null; }
  return { buffer, contentType, attachment, name: real.split('/').pop() };
}

export { readUserFile };
