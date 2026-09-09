/*
 * Screenshots produced during a session: the images an agent wrote or looked at (agent-browser
 * captures, Playwright/UI-diff shots, generated PNGs…). They are scattered on disk (/tmp,
 * ~/.agent-browser/tmp/screenshots, the repo itself) and, until now, only visible as a file path
 * buried in a tool chip.
 *
 * The signal is the TRANSCRIPT, not a directory scan: an image is a screenshot of this session iff
 * a `Read` / `Write` tool_use of the session (or of one of its sub-agents) carries it as
 * `file_path`. Read covers the common case — the CLI that produced the shot is a Bash call whose
 * output is just a path, and the agent then Reads the file to actually see it.
 *
 * That list is also the ALLOWLIST used to serve the bytes (cf. readScreenshot / /api/screenshot):
 * the server may be bound to 0.0.0.0, so a path coming from the client is never read as-is.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './config.js';
import { readdirSafe, statSafe } from './util.js';
import { incrementalReader } from './incremental.js';

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const CONTENT_TYPE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const TOOLS = new Set(['Read', 'Write']);
const MAX_SHOTS = 40;
const MAX_BYTES = 25 * 1024 * 1024;

const isImagePath = (p) => IMG_EXT.has(path.extname(p || '').toLowerCase());

// Replie une ligne de transcript : tout tool_use Read/Write dont le file_path est une image.
// Le test textuel préalable évite le JSON.parse sur l'immense majorité des lignes.
function foldLine(acc, line) {
  if (!line || !/\.(png|jpe?g|webp|gif)/i.test(line)) return;
  let j;
  try { j = JSON.parse(line); } catch (_) { return; }
  const c = j && j.message && j.message.content;
  if (!Array.isArray(c)) return;
  const cwd = typeof j.cwd === 'string' ? j.cwd : '';
  for (const b of c) {
    if (!b || b.type !== 'tool_use' || !TOOLS.has(b.name)) continue;
    const f = b.input && b.input.file_path;
    if (typeof f !== 'string' || !f || !isImagePath(f)) continue;
    const abs = path.isAbsolute(f) ? f : (cwd ? path.resolve(cwd, f) : null);
    if (!abs) continue;
    acc.set(abs, j.timestamp || acc.get(abs) || null); // dernière vue de ce chemin
  }
}

// Fichiers encore présents sur disque, les plus récents d'abord, bornés (payload du détail).
function finalizeShots(acc) {
  const out = [];
  for (const [abs, ts] of acc) {
    const st = statSafe(abs);
    if (!st || !st.isFile() || st.size > MAX_BYTES) continue;
    out.push({ path: abs, name: abs.split('/').pop(), ts, mtime: st.mtimeMs, size: st.size });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, MAX_SHOTS);
}

// Lecture incrémentale par fichier (les transcripts sont append-only et sessionDetail rejoue à
// chaque tick de poll) : un fichier inchangé ne coûte rien.
const readShots = incrementalReader({
  init: () => new Map(),
  fold: foldLine,
  finalize: finalizeShots,
  empty: [],
});

// Transcripts de sous-agents d'une session : `<proj>/<session>/subagents/agent-*.jsonl` et, pour
// les runs de workflow, un niveau plus bas (cf. agentTranscriptPath dans transcript.js).
function subagentTranscripts(sessionFile, sessionId) {
  const dir = path.join(path.dirname(sessionFile), sessionId, 'subagents');
  const out = [];
  for (const f of readdirSafe(dir)) {
    if (f.startsWith('agent-') && f.endsWith('.jsonl')) out.push(path.join(dir, f));
  }
  const wf = path.join(dir, 'workflows');
  for (const run of readdirSafe(wf)) {
    for (const f of readdirSafe(path.join(wf, run))) {
      if (f.startsWith('agent-') && f.endsWith('.jsonl')) out.push(path.join(wf, run, f));
    }
  }
  return out;
}

// Screenshots de la session ET de ses sous-agents (un agent-browser lancé en sous-agent est le cas
// le plus courant). Dédupliqué par chemin, plus récents d'abord.
function buildScreenshots(sessionFile, sessionId) {
  if (!sessionFile) return [];
  const seen = new Map();
  for (const fp of [sessionFile, ...subagentTranscripts(sessionFile, sessionId || '')]) {
    for (const shot of readShots(fp)) {
      const prev = seen.get(shot.path);
      if (!prev || (shot.ts || '') > (prev.ts || '')) seen.set(shot.path, shot);
    }
  }
  return [...seen.values()].sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SHOTS);
}

// localise le transcript principal d'une session à partir de son id (miroir de userFiles.js).
function transcriptOf(sessionId, projectsDir) {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId || '')) return null;
  for (const proj of readdirSafe(projectsDir)) {
    const cand = path.join(projectsDir, proj, sessionId + '.jsonl');
    const st = statSafe(cand);
    if (st && st.isFile()) return cand;
  }
  return null;
}

// Sert un screenshot pour l'UI. `absPath` n'est servi que s'il figure dans la liste rebâtie depuis
// le transcript de CETTE session (realpath → path traversal / symlink hors liste bloqués).
function readScreenshot(sessionId, absPath, projectsDir = PROJECTS_DIR) {
  if (typeof absPath !== 'string' || !absPath || !isImagePath(absPath)) return null;
  const fp = transcriptOf(sessionId, projectsDir);
  if (!fp) return null;
  let real;
  try { real = fs.realpathSync(absPath); } catch (_) { return null; }
  const allowed = new Set();
  for (const shot of buildScreenshots(fp, sessionId)) {
    try { allowed.add(fs.realpathSync(shot.path)); } catch (_) { /* disparu */ }
  }
  if (!allowed.has(real)) return null;
  const st = statSafe(real);
  if (!st || !st.isFile() || st.size > MAX_BYTES) return null;
  let buffer;
  try { buffer = fs.readFileSync(real); } catch (_) { return null; }
  return { buffer, contentType: CONTENT_TYPE[path.extname(real).toLowerCase()], name: real.split('/').pop() };
}

export { buildScreenshots, readScreenshot };
