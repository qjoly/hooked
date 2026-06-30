/*
 * Résolution du dépôt GitHub d'un projet (owner/repo) à partir du remote git.
 * Sert à regrouper les sessions par dépôt plutôt que par dossier : plusieurs workspaces
 * jj / worktrees git du même dépôt se retrouvent ainsi dans un seul groupe.
 * Lecture directe des fichiers de config (zéro subprocess), avec cache invalidé par mtime.
 */
import fs from 'node:fs';
import path from 'node:path';
import { statSafe } from './util.js';

const slugCache = new Map(); // cwd -> { slug, configFile, mtime }

// localise le fichier de config git pertinent en remontant depuis cwd :
//  - .git répertoire (repo normal / jj colocaté) → <dir>/config
//  - .git fichier (worktree git)                 → "gitdir: …" puis commondir → config commun
//  - .jj/repo/store/git/config (jj non colocaté)
function findGitConfig(cwd) {
  let dir = cwd;
  for (let i = 0; i < 40 && dir; i++) {
    const dotgit = path.join(dir, '.git');
    const st = statSafe(dotgit);
    if (st && st.isDirectory()) return path.join(dotgit, 'config');
    if (st && st.isFile()) {
      try {
        const m = fs.readFileSync(dotgit, 'utf8').match(/gitdir:\s*(.+)/);
        if (m) {
          const gd = path.resolve(dir, m[1].trim());
          let commonDir = gd;
          try { commonDir = path.resolve(gd, fs.readFileSync(path.join(gd, 'commondir'), 'utf8').trim()); } catch (_) {}
          return path.join(commonDir, 'config');
        }
      } catch (_) {}
    }
    const jjcfg = path.join(dir, '.jj', 'repo', 'store', 'git', 'config');
    if (statSafe(jjcfg)) return jjcfg;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// extrait owner/repo d'une URL git (ssh `git@host:owner/repo`, ssh://, https://).
function slugFromUrl(url) {
  if (!url) return null;
  const m = url.trim().replace(/\.git$/, '').match(/[/:]([^/:]+\/[^/]+)$/);
  return m ? m[1] : null;
}

// URL du remote `origin` (à défaut, le premier remote déclaré) dans un fichier de config git.
function parseOriginUrl(configFile) {
  let txt;
  try { txt = fs.readFileSync(configFile, 'utf8'); } catch (_) { return null; }
  let inOrigin = false, originUrl = null, firstUrl = null;
  for (const line of txt.split('\n')) {
    const sec = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]/);
    if (sec) { inOrigin = sec[1] === 'origin'; continue; }
    if (/^\s*\[/.test(line)) inOrigin = false;
    const u = line.match(/^\s*url\s*=\s*(.+)$/);
    if (u) {
      if (inOrigin && !originUrl) originUrl = u[1].trim();
      if (!firstUrl) firstUrl = u[1].trim();
    }
  }
  return originUrl || firstUrl;
}

// slug GitHub `owner/repo` du projet en cwd, ou null si aucun remote. Caché par cwd,
// réévalué uniquement quand le mtime du config change (les remotes ne bougent quasi jamais).
function repoSlug(cwd) {
  if (!cwd) return null;
  const cached = slugCache.get(cwd);
  if (cached) {
    if (!cached.configFile) return cached.slug; // négatif mémorisé : pas de remote
    const st = statSafe(cached.configFile);
    if (st && st.mtimeMs === cached.mtime) return cached.slug;
  }
  const cfg = findGitConfig(cwd);
  const st = cfg ? statSafe(cfg) : null;
  const slug = st ? slugFromUrl(parseOriginUrl(cfg)) : null;
  slugCache.set(cwd, { slug, configFile: cfg, mtime: st ? st.mtimeMs : 0 });
  return slug;
}

export { repoSlug, slugFromUrl, findGitConfig, parseOriginUrl };
