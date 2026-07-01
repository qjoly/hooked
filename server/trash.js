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
import { PROJECTS_DIR } from './config.js';
import { scanSessions, getSummary } from './transcript.js';
import { readdirSafe, statSafe } from './util.js';

// Sous-dossier corbeille dans chaque dossier projet (~/.claude/projects/<projet>/bin/).
const TRASH_SUBDIR = 'bin';

// id de session valide (uuid-like) : liste blanche stricte anti-traversal (interpolé dans un chemin).
const isValidId = (id) => typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id) && !id.includes('..');

// Met une session à la corbeille : <projet>/<id>.jsonl → <projet>/bin/<id>.jsonl.
// Source de vérité = scanSessions() (même liste que le dashboard) → on ne déplace qu'un
// transcript de premier niveau réellement listé (jamais un sous-agent, jamais un bin/).
function trashSession(id, cb) {
  const done = typeof cb === 'function' ? cb : () => {};
  try {
    if (!isValidId(id)) return done({ code: 400, message: 'id de session invalide' });
    const s = scanSessions().find((x) => x.id === id);
    if (!s || !s.file) return done({ code: 404, message: 'session introuvable (déjà à la corbeille ?)' });
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
function restoreSession(id, cb) {
  const done = typeof cb === 'function' ? cb : () => {};
  try {
    if (!isValidId(id)) return done({ code: 400, message: 'id de session invalide' });
    for (const proj of readdirSafe(PROJECTS_DIR)) {
      const binDir = path.join(PROJECTS_DIR, proj, TRASH_SUBDIR);
      const st = statSafe(binDir);
      if (!st || !st.isDirectory()) continue;
      const hit = readdirSafe(binDir).find((f) => f === id + '.jsonl' || f.startsWith(id + '.'));
      if (!hit) continue;
      const from = path.join(binDir, hit);
      const dest = path.join(PROJECTS_DIR, proj, id + '.jsonl');
      if (statSafe(dest)) return done({ code: 409, message: 'un transcript actif porte déjà cet id' });
      fs.renameSync(from, dest);
      return done(null, { id, from, to: dest });
    }
    return done({ code: 404, message: 'session absente de la corbeille' });
  } catch (e) {
    return done({ code: 500, message: e.message || String(e) });
  }
}

// Liste les sessions à la corbeille (tous projets) : parse chaque <projet>/bin/*.jsonl pour
// en tirer un résumé (titre, projet, coût…) + la date de mise à la corbeille (mtime du fichier).
function listTrashed(projectsDir = PROJECTS_DIR) {
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
  out.sort((a, b) => String(b.trashedAt || '').localeCompare(String(a.trashedAt || '')));
  return out;
}

export { trashSession, restoreSession, listTrashed };
