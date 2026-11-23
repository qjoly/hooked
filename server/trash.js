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
import { PROJECTS_DIR, PI_SESSIONS_DIR } from './config.js';
import { scanSessions, getSummary } from './transcript.js';
import { scanPiSessions, piSetArchived, piRead } from './pi.js';
import { finalizePi as finalizePiForTrash } from './pi.js';
import { readdirSafe, statSafe } from './util.js';
import { findSessionAny } from './sessions.js';
import { engineForSession } from './providers.js';
import { journalRoot, readJournal, summarizeJournal, findTrashedJournal, journalSetArchived } from './engines/journal.js';

// Sous-dossier corbeille dans chaque dossier projet (~/.claude/projects/<projet>/bin/).
const TRASH_SUBDIR = 'bin';

// id de session valide (uuid-like) : liste blanche stricte anti-traversal (interpolé dans un chemin).
const isValidId = (id) => typeof id === 'string' && /^[A-Za-z0-9._-]+$/.test(id) && !id.includes('..');

// Met une session à la corbeille : <projet>/<id>.jsonl → <projet>/bin/<id>.jsonl (claude), ou
// le fichier pi est renommé en .jsonl.trashed (cf. piSetArchived ; la session quitte
// scanPiSessions et n'apparaît plus dans le dashboard).
// Source de vérité = scanAllSessions-equivalent (même liste que le dashboard) → on ne touche
// qu'une session réellement listée (jamais un sous-agent, jamais un bin/).
function trashSession(id, cb, piSessionsDir = PI_SESSIONS_DIR) {
  const done = typeof cb === 'function' ? cb : () => {};
  try {
    if (!isValidId(id)) return done({ code: 400, message: 'invalid session id' });
    const s = scanSessions().find((x) => x.id === id) || scanPiSessions(piSessionsDir).find((x) => x.id === id);
    if (!s || !s.file) {
      // Another engine's session (ACP / external provider journal…): archived by its engine.
      const other = findSessionAny(id);
      const eng = other && other.file ? engineForSession(other) : null;
      if (eng && eng.id !== 'claude' && typeof eng.setArchived === 'function') {
        if (!eng.setArchived(other, true)) return done({ code: 500, message: `could not archive ${other.provider} session` });
        return done(null, { id, from: other.file, to: other.file + '.trashed', project: other.projectName || null, provider: other.provider });
      }
      return done({ code: 404, message: 'session not found (already in trash?)' });
    }
    if (s.provider === 'pi') {
      if (!piSetArchived(s.file, true)) return done({ code: 500, message: 'could not archive pi session' });
      return done(null, { id, from: s.file, to: s.file + '.trashed', project: s.projectName || null, provider: 'pi' });
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
function restoreSession(id, cb, piSessionsDir = PI_SESSIONS_DIR) {
  const done = typeof cb === 'function' ? cb : () => {};
  try {
    if (!isValidId(id)) return done({ code: 400, message: 'invalid session id' });
    // Session pi archivée : chercher un fichier <id>.jsonl.trashed sous piSessionsDir.
    for (const d of readdirSafe(piSessionsDir)) {
      const dir = path.join(piSessionsDir, d);
      if (!statSafe(dir)?.isDirectory()) continue;
      for (const f of readdirSafe(dir)) {
        if (!f.endsWith('.jsonl.trashed')) continue;
        const read = piRead(path.join(dir, f));
        if (read?.header?.id === id) {
          const trashed = path.join(dir, f);
          if (!piSetArchived(trashed, false)) return done({ code: 500, message: 'could not restore pi session' });
          return done(null, { id, from: trashed, to: trashed.slice(0, -8), provider: 'pi' });
        }
      }
    }
    // Journaled session (ACP / external provider) renamed .trashed.
    const journaled = findTrashedJournal(id);
    if (journaled) {
      if (!journalSetArchived(journaled, false)) return done({ code: 500, message: 'could not restore session' });
      return done(null, { id, from: journaled, to: journaled.slice(0, -'.trashed'.length) });
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
function listTrashed(projectsDir = PROJECTS_DIR, piSessionsDir = PI_SESSIONS_DIR) {
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
  // Sessions pi archivées (.jsonl.trashed) — même liste que le dashboard, côté pi.
  for (const d of readdirSafe(piSessionsDir)) {
    const dir = path.join(piSessionsDir, d);
    if (!statSafe(dir)?.isDirectory()) continue;
    for (const f of readdirSafe(dir)) {
      if (!f.endsWith('.jsonl.trashed')) continue;
      const fp = path.join(dir, f);
      const read = piRead(fp);
      if (!read) continue;
      const fst = statSafe(fp);
      const sum = finalizePiForTrash(read);
      out.push({
        id: read.header.id, title: sum.title, firstPrompt: sum.firstPrompt,
        project: read.header.cwd, projectName: read.header.cwd ? path.basename(read.header.cwd) : null,
        lastTs: sum.lastTs, cost: sum.cost, userPrompts: sum.userPrompts,
        trashedAt: fst ? new Date(fst.mtimeMs).toISOString() : null, provider: 'pi',
      });
    }
  }
  // Journaled sessions (ACP / external providers) renamed .trashed.
  const root = journalRoot();
  for (const d of readdirSafe(root)) {
    const dir = path.join(root, d);
    if (!statSafe(dir)?.isDirectory()) continue;
    for (const f of readdirSafe(dir)) {
      if (!f.endsWith('.jsonl.trashed')) continue;
      const fp = path.join(dir, f);
      const read = readJournal(fp);
      if (!read) continue;
      const sum = summarizeJournal(read, d);
      const fst = statSafe(fp);
      out.push({
        id: sum.id, title: sum.title, firstPrompt: sum.firstPrompt,
        project: sum.project, projectName: sum.projectName,
        lastTs: sum.lastTs, cost: sum.cost, userPrompts: sum.userPrompts,
        trashedAt: fst ? new Date(fst.mtimeMs).toISOString() : null, provider: sum.provider,
      });
    }
  }
  out.sort((a, b) => String(b.trashedAt || '').localeCompare(String(a.trashedAt || '')));
  return out;
}

export { trashSession, restoreSession, listTrashed };
