/*
 * Corbeille de sessions. « Supprimer » une session = déplacer son transcript de premier
 * niveau vers un sous-dossier corbeille `<projet>/bin/`. scanSessions() (cf. transcript.js)
 * ne descend PAS dans les sous-dossiers : la session quitte donc le dashboard ET l'index
 * de recherche (GC au prochain refresh) — sans rien perdre : le fichier est seulement
 * déplacé, récupérable via restoreSession (ou un simple `mv`).
 *
 * Réversible par design : aucune suppression destructive ici.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR, VIBE_SESSIONS_DIR } from './config.js';
import { scanSessions, getSummary } from './transcript.js';
import { scanVibeSessions, getVibeSession, vibeSetArchived } from './vibe.js';
import { readdirSafe, statSafe } from './util.js';

// Sous-dossier corbeille dans chaque dossier projet (~/.claude/projects/<projet>/bin/).
const TRASH_SUBDIR = 'bin';

// id de session valide (uuid-like) : liste blanche stricte anti-traversal (interpolé dans un chemin).
const isValidId = (id) => typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id) && !id.includes('..');

// Met une session à la corbeille : <projet>/<id>.jsonl → <projet>/bin/<id>.jsonl (claude), ou
// `archived_at` posé dans meta.json (vibe — meta.json n'est pas chaîné en sha256 côté Vibe, cf.
// vibeSetArchived ; la session quitte scanVibeSessions et n'apparaît plus dans le dashboard).
// Source de vérité = scanAllSessions-equivalent (même liste que le dashboard) → on ne touche
// qu'une session réellement listée (jamais un sous-agent, jamais un bin/).
function trashSession(id, cb, vibeSessionsDir = VIBE_SESSIONS_DIR) {
  const done = typeof cb === 'function' ? cb : () => {};
  try {
    if (!isValidId(id)) return done({ code: 400, message: 'invalid session id' });
    const s = scanSessions().find((x) => x.id === id) || scanVibeSessions(vibeSessionsDir).find((x) => x.id === id);
    if (!s || !s.file) return done({ code: 404, message: 'session not found (already in trash?)' });
    if (s.provider === 'vibe') {
      if (!vibeSetArchived(s.dir, true)) return done({ code: 500, message: 'could not archive vibe session' });
      return done(null, { id, from: s.dir, to: s.dir + ' (archived_at)', project: s.projectName || null, provider: 'vibe' });
    }
    const binDir = path.join(path.dirname(s.file), TRASH_SUBDIR);
    fs.mkdirSync(binDir, { recursive: true });
    let dest = path.join(binDir, path.basename(s.file));
    // Ne jamais écraser une entrée déjà présente dans la corbeille : suffixe horodaté.
    if (statSafe(dest)) dest = path.join(binDir, path.basename(s.file, '.jsonl') + '.' + Date.now() + '.jsonl');
    fs.renameSync(s.file, dest);
    return done(null, { id, from: s.file, to: dest, project: s.projectName || null });
  } catch (e) {
    return done({ code: 500, message: e.message || String(e) });
  }
}

// Restaure une session depuis la corbeille : cherche <projet>/bin/<id>*.jsonl et le remonte
// d'un niveau. Réciproque de trashSession (filet de sécurité / réversibilité).
function restoreSession(id, cb, vibeSessionsDir = VIBE_SESSIONS_DIR) {
  const done = typeof cb === 'function' ? cb : () => {};
  try {
    if (!isValidId(id)) return done({ code: 400, message: 'invalid session id' });
    // Session vibe archivée : chercher un dossier unified dont meta.json a archived_at + cet id.
    for (const d of readdirSafe(vibeSessionsDir)) {
      const dir = path.join(vibeSessionsDir, d);
      const metaPath = path.join(dir, 'meta.json');
      let meta;
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) { continue; }
      if (meta.session_id === id && meta.archived_at) {
        if (!vibeSetArchived(dir, false)) return done({ code: 500, message: 'could not restore vibe session' });
        return done(null, { id, from: dir + ' (archived_at)', to: dir, provider: 'vibe' });
      }
    }
    for (const proj of readdirSafe(PROJECTS_DIR)) {
      const binDir = path.join(PROJECTS_DIR, proj, TRASH_SUBDIR);
      const st = statSafe(binDir);
      if (!st || !st.isDirectory()) continue;
      const hit = readdirSafe(binDir).find((f) => f === id + '.jsonl' || f.startsWith(id + '.'));
      if (!hit) continue;
      const from = path.join(binDir, hit);
      const dest = path.join(PROJECTS_DIR, proj, id + '.jsonl');
      if (statSafe(dest)) return done({ code: 409, message: 'an active transcript already has this id' });
      fs.renameSync(from, dest);
      return done(null, { id, from, to: dest });
    }
    return done({ code: 404, message: 'session not in trash' });
  } catch (e) {
    return done({ code: 500, message: e.message || String(e) });
  }
}

// Liste les sessions à la corbeille (tous projets) : parse chaque <projet>/bin/*.jsonl pour
// en tirer un résumé (titre, projet, coût…) + la date de mise à la corbeille (mtime du fichier).
function listTrashed(projectsDir = PROJECTS_DIR, vibeSessionsDir = VIBE_SESSIONS_DIR) {
  const out = [];
  for (const proj of readdirSafe(projectsDir)) {
    const binDir = path.join(projectsDir, proj, TRASH_SUBDIR);
    const dst = statSafe(binDir);
    if (!dst || !dst.isDirectory()) continue;
    for (const f of readdirSafe(binDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(binDir, f);
      const fst = statSafe(fp);
      const sum = getSummary(fp, f.replace(/\.jsonl$/, '').replace(/\.\d+$/, ''));
      if (!sum) continue;
      out.push({
        id: sum.id, title: sum.title, firstPrompt: sum.firstPrompt,
        project: sum.project, projectName: sum.projectName,
        lastTs: sum.lastTs, cost: sum.cost, userPrompts: sum.userPrompts,
        trashedAt: fst ? new Date(fst.mtimeMs).toISOString() : null,
      });
    }
  }
  // Sessions vibe archivées (meta.json archived_at) — même liste que le dashboard, côté vibe.
  for (const d of readdirSafe(vibeSessionsDir)) {
    const dir = path.join(vibeSessionsDir, d);
    if (!statSafe(path.join(dir, 'journal'))) continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch (_) { continue; }
    if (!meta.archived_at) continue;
    const sum = getVibeSession(dir);
    out.push({
      id: sum.id, title: sum.title, firstPrompt: sum.firstPrompt,
      project: sum.project, projectName: sum.projectName,
      lastTs: sum.lastTs, cost: sum.cost, userPrompts: sum.userPrompts,
      trashedAt: meta.archived_at, provider: 'vibe',
    });
  }
  out.sort((a, b) => String(b.trashedAt || '').localeCompare(String(a.trashedAt || '')));
  return out;
}

export { trashSession, restoreSession, listTrashed };
