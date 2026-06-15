/*
 * Listing des fichiers d'un projet (auto-complétion @) + score de correspondance floue
 * (sous-séquence façon fzf) pour classer les résultats par pertinence.
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE_IGNORE = new Set(['node_modules', '.git', '.jj', '.hg', '.svn', 'dist', 'build', 'out',
  '.next', '.nuxt', '.cache', 'coverage', 'vendor', '.venv', 'venv', '__pycache__',
  'target', '.idea', '.gradle', '.terraform', 'tmp', '.DS_Store']);

function listFilesUnder(root, max = 5000) {
  const out = [];
  const stack = [root];
  let scanned = 0;
  while (stack.length && out.length < max) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (++scanned > 80000) break;
      if (FILE_IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue; // dossiers cachés ignorés (sauf besoin explicite)
        stack.push(full);
      } else if (e.isFile()) {
        out.push(path.relative(root, full));
        if (out.length >= max) break;
      }
    }
  }
  return out;
}
// cache temporel par dossier racine (le listing complet est trop coûteux à chaque frappe)
const filesCache = new Map(); // root -> { at, list }
function projectFiles(root) {
  const c = filesCache.get(root);
  const now = Date.now();
  if (c && now - c.at < 10000) return c.list;
  const list = listFilesUnder(root);
  filesCache.set(root, { at: now, list });
  return list;
}
// score de correspondance « floue » (sous-séquence façon fzf). Plus bas = meilleur, null si pas de match.
function fuzzyScore(target, q) {
  const s = target.toLowerCase();
  let si = 0, score = 0, prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = s.indexOf(q[qi], si);
    if (idx < 0) return null;
    score += idx - si;                                  // pénalité d'écart
    if (idx === prev + 1) score -= 1.5;                 // bonus contigu
    if (idx === 0 || '/._- '.includes(s[idx - 1])) score -= 2; // bonus début de segment
    prev = idx;
    si = idx + 1;
  }
  return score;
}
// filtre + classement par pertinence (floue). Le match sur le nom de fichier prime sur le chemin.
function matchFiles(list, q, limit = 40) {
  q = (q || '').toLowerCase().trim();
  if (!q) return list.slice(0, limit);
  const scored = [];
  for (const f of list) {
    const base = f.slice(f.lastIndexOf('/') + 1);
    const sb = fuzzyScore(base, q);
    const sf = fuzzyScore(f, q);
    if (sb == null && sf == null) continue;
    let score = sb != null ? sb : sf + 12;              // match basename prioritaire
    score += f.length * 0.01;                           // biais chemins courts
    scored.push([f, score]);
  }
  scored.sort((a, b) => a[1] - b[1] || a[0].length - b[0].length);
  return scored.slice(0, limit).map((x) => x[0]);
}

export { FILE_IGNORE, listFilesUnder, projectFiles, fuzzyScore, matchFiles };
