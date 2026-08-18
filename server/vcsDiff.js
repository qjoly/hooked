/*
 * Diff du dépôt de version (working tree) d'un projet de session — l'AUTRE regard sur les
 * changements, en complément du diff « Claude » reconstruit depuis le transcript (changes.js).
 * Ici on montre ce que le dépôt considère comme non commité, tel quel.
 *
 * Détection VCS (detectVcs) :
 *   - dépôt git (ou jj COLOCATÉ : .git ET .jj coexistent) → plomberie git, la plus fiable.
 *     En colocaté, jj garde le HEAD git sur `@-` → `git diff HEAD` == `jj diff`.
 *   - jj NON colocaté (.jj sans .git exploitable) → commandes jj.
 *   Le libellé affiché est « jj » dès qu'un `.jj` est présent (préférence outil), même si le
 *   mécanisme sous-jacent reste git.
 *
 * Sécurité : execFile('git'|'jj', [argv…]) — jamais de shell (cf. server/gitOps.js). Le seul
 * intrant est le cwd de la session (issu du transcript, pas du client web).
 *
 * Sortie : { vcs, changes } où chaque change a la MÊME forme que buildFileChanges (file, name,
 * ops:[{kind:'edit', old, new, all, ts}], count) + un `badge` de statut, pour réutiliser tel quel
 * le rendu Diff/PierreDiff du front. Les fichiers binaires portent `binary:true` (pas de diff).
 *
 * Nested repos: besides the primary repo, a bounded scan (scanSubRepos + .gitmodules) finds
 * git/jj repos nested under the base and reports one `repos[]` entry per repo — including
 * the "workspace of clones" case where the cwd itself is under no VCS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { statSafe } from './util.js';
import { FILE_IGNORE } from './files.js';

const FILE_MAX = 200000; // cap par côté (old/new) d'un fichier
const MAX_FILES = 60;    // budget global de fichiers rendus, tous dépôts confondus
const TIMEOUT = 20000;
const SUBREPO_MAX = 10;    // max nested repos reported
const SCAN_DEPTH = 3;      // levels scanned below the base for nested repos
const SCAN_MAX_DIRS = 2000; // directories visited before the scan gives up

// execFile en buffer (gère le -z null-séparé ET la détection de binaire). Ne rejette jamais.
function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: TIMEOUT, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
      resolve({
        failed: !!err,
        stdout: stdout || Buffer.alloc(0),
        stderr: (stderr || Buffer.alloc(0)).toString(),
      });
    });
  });
}

// Buffer → texte, ou null si binaire (octet NUL) ; tronqué à FILE_MAX.
function textOrNull(buf) {
  if (!buf || !buf.length) return '';
  const b = buf.length > FILE_MAX ? buf.subarray(0, FILE_MAX) : buf;
  if (b.includes(0)) return null;
  return b.toString('utf8');
}

// Remonte depuis cwd pour trouver un répertoire contenant `name` (ex. .jj). Renvoie ce répertoire.
function findUp(cwd, name) {
  let dir = cwd;
  for (let i = 0; i < 40 && dir; i++) {
    if (statSafe(path.join(dir, name))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// { kind:'git'|'jj', mechanism:'git'|'jj', root } ou null.
async function detectVcs(cwd) {
  if (!cwd) return null;
  const jjRoot = findUp(cwd, '.jj');
  const top = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], cwd);
  if (!top.failed) {
    const root = top.stdout.toString('utf8').trim();
    if (root) return { kind: jjRoot ? 'jj' : 'git', mechanism: 'git', root };
  }
  if (jjRoot) return { kind: 'jj', mechanism: 'jj', root: jjRoot };
  return null;
}

// Bounded BFS under `base` looking for nested repos: a dir holding a `.git` entry (dir OR
// file — submodules and linked worktrees use a file) or a `.jj` dir. Found repos are not
// descended into (no recursive nesting); symlinks are never followed (no cycles). Bare
// repos are naturally excluded (their directory IS the git dir, no inner `.git` entry).
function scanSubRepos(base) {
  const found = [];
  const queue = [{ dir: base, depth: 0 }];
  let visited = 0;
  while (queue.length && found.length < SUBREPO_MAX && visited < SCAN_MAX_DIRS) {
    const { dir, depth } = queue.shift();
    visited++;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    if (dir !== base) {
      const hasGit = entries.some((e) => e.name === '.git');
      const hasJj = entries.some((e) => e.name === '.jj');
      if (hasGit || hasJj) { found.push({ root: dir, hasGit, hasJj }); continue; }
    }
    if (depth >= SCAN_DEPTH) continue;
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name.startsWith('.') || FILE_IGNORE.has(e.name)) continue;
      queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return found;
}

// Submodule paths declared in .gitmodules — the walk alone misses submodules living under
// ignored dirs (vendor/, …). Only initialized ones (an existing `.git` entry) are kept.
async function gitmodulesPaths(root) {
  const gm = path.join(root, '.gitmodules');
  if (!statSafe(gm)) return [];
  const r = await run('git', ['config', '--file', gm, '--get-regexp', String.raw`submodule\..*\.path`], root);
  if (r.failed) return [];
  const out = [];
  for (const line of r.stdout.toString('utf8').split('\n')) {
    const sp = line.indexOf(' ');
    const rel = sp < 0 ? '' : line.slice(sp + 1).trim();
    if (rel) out.push(rel);
  }
  return out;
}

// detectVcs() escapes upward (findUp / rev-parse), which would mislabel a sub-repo nested
// in a differently-flavored parent — derive kind/mechanism from the walk entries instead.
function subRepoInfo({ root, hasGit, hasJj }) {
  return hasGit
    ? { root, kind: hasJj ? 'jj' : 'git', mechanism: 'git' }
    : { root, kind: 'jj', mechanism: 'jj' };
}

const GIT_STATUS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', '?': 'untracked', T: 'typechange' };

function makeEntry(root, relPath, badge, oldT, newT) {
  const binary = oldT === null || newT === null;
  return {
    file: path.join(root, relPath),
    name: path.basename(relPath),
    badge,
    binary,
    ops: [{ kind: 'edit', old: binary ? '' : (oldT || ''), new: binary ? '' : (newT || ''), all: false, ts: null }],
    count: 1,
  };
}

// Contenu d'un fichier à HEAD (git), buffer vide si absent (fichier ajouté).
async function gitShowHead(root, relPath) {
  const r = await run('git', ['-C', root, 'show', `HEAD:${relPath}`], root);
  return r.failed ? Buffer.alloc(0) : r.stdout;
}
function readDisk(abs) {
  try { return fs.readFileSync(abs); } catch (_) { return Buffer.alloc(0); }
}

async function gitChanges(root, limit = MAX_FILES) {
  const specs = []; // { code, oldp, newp }
  const ns = await run('git', ['-C', root, 'diff', '--name-status', '-z', 'HEAD'], root);
  if (!ns.failed) {
    const toks = ns.stdout.toString('utf8').split('\0');
    let i = 0;
    while (i < toks.length) {
      const st = toks[i++];
      if (!st) continue;
      const code = st[0];
      if (code === 'R' || code === 'C') {
        const oldp = toks[i++]; const newp = toks[i++];
        specs.push({ code, oldp, newp });
      } else {
        const p = toks[i++];
        if (p) specs.push({ code, oldp: p, newp: p });
      }
    }
  }
  const un = await run('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], root);
  if (!un.failed) {
    for (const p of un.stdout.toString('utf8').split('\0').filter(Boolean)) specs.push({ code: '?', oldp: p, newp: p });
  }

  // Gitlink specs (submodule pointer moves) and untracked nested clones resolve to a
  // directory on disk — no file diff to show; the nested repo gets its own entry instead.
  const files = specs.filter(({ code, oldp, newp }) => {
    const st = statSafe(path.join(root, code === 'D' ? oldp : newp));
    return !(st && st.isDirectory());
  });

  const capped = files.slice(0, limit);
  const out = await Promise.all(capped.map(async ({ code, oldp, newp }) => {
    const oldBuf = code === 'A' || code === '?' ? Buffer.alloc(0) : await gitShowHead(root, oldp);
    const newBuf = code === 'D' ? Buffer.alloc(0) : readDisk(path.join(root, newp));
    return makeEntry(root, code === 'D' ? oldp : newp, GIT_STATUS[code] || 'changed', textOrNull(oldBuf), textOrNull(newBuf));
  }));
  return out;
}

const JJ_STATUS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied' };

// Contenu d'un fichier chez le parent de la copie de travail (@-). Vide si absent (ajouté).
async function jjShowParent(root, relPath) {
  const r = await run('jj', ['file', 'show', '-r', '@-', relPath], root);
  return r.failed ? Buffer.alloc(0) : r.stdout;
}

async function jjChanges(root, limit = MAX_FILES) {
  const sum = await run('jj', ['diff', '--summary'], root);
  if (sum.failed) return [];
  const specs = [];
  for (const line of sum.stdout.toString('utf8').split('\n')) {
    const m = line.match(/^([A-Z])\s+(.+)$/);
    if (m) specs.push({ code: m[1], p: m[2].trim() });
  }
  const capped = specs.slice(0, limit);
  const out = await Promise.all(capped.map(async ({ code, p }) => {
    const oldBuf = code === 'A' ? Buffer.alloc(0) : await jjShowParent(root, p);
    const newBuf = code === 'D' ? Buffer.alloc(0) : readDisk(path.join(root, p));
    return makeEntry(root, p, JJ_STATUS[code] || 'changed', textOrNull(oldBuf), textOrNull(newBuf));
  }));
  return out;
}

// { vcs, root, changes, truncated, repos:[{ kind, root, label, primary, changes }] }.
// `repos` lists every detected repo, primary first when it exists; nested repos are scanned
// under the base (primary root, or cwd for a plain "workspace of clones" dir — never above,
// so a cwd inside a sub-repo won't pull in a versioned $HOME or sibling repos). Top-level
// vcs/root/changes keep mirroring the primary repo. MAX_FILES is a global budget: repos
// past it stay listed with empty changes and `truncated` flips to true.
async function buildVcsChanges(cwd) {
  const empty = { vcs: null, root: null, changes: [], truncated: false, repos: [] };
  if (!cwd) return empty;
  const primary = await detectVcs(cwd);
  const base = primary ? primary.root : cwd;

  const walked = scanSubRepos(base);
  if (primary && primary.mechanism === 'git') {
    for (const rel of await gitmodulesPaths(base)) {
      const root = path.resolve(base, rel);
      if (!root.startsWith(base + path.sep)) continue;
      if (statSafe(path.join(root, '.git'))) walked.push({ root, hasGit: true, hasJj: false });
    }
  }
  const byRoot = new Map();
  for (const w of walked) if (!byRoot.has(w.root)) byRoot.set(w.root, w);
  const subs = [...byRoot.values()].map(subRepoInfo)
    .sort((a, b) => a.root.localeCompare(b.root))
    .slice(0, SUBREPO_MAX)
    .map((s) => ({ ...s, primary: false }));

  const list = primary ? [{ ...primary, primary: true }, ...subs] : subs;
  if (!list.length) return empty;

  let budget = MAX_FILES;
  let truncated = false;
  const repos = [];
  for (const r of list) {
    let changes = [];
    if (budget > 0) {
      changes = r.mechanism === 'jj' ? await jjChanges(r.root, budget) : await gitChanges(r.root, budget);
      budget -= changes.length;
    } else {
      truncated = true;
    }
    repos.push({ kind: r.kind, root: r.root, label: r.primary ? '' : path.relative(base, r.root), primary: r.primary, changes });
  }
  const vcs = primary ? primary.kind : (repos.every((r) => r.kind === 'jj') ? 'jj' : 'git');
  return { vcs, root: base, changes: repos[0].primary ? repos[0].changes : [], truncated, repos };
}

export { detectVcs, scanSubRepos, buildVcsChanges };
