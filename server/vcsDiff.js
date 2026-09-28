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

// Contenu d'un fichier à une révision git donnée, buffer vide si absent (fichier ajouté).
async function gitShowAt(root, ref, relPath) {
  const r = await run('git', ['-C', root, 'show', `${ref}:${relPath}`], root);
  return r.failed ? Buffer.alloc(0) : r.stdout;
}
function readDisk(abs) {
  try { return fs.readFileSync(abs); } catch (_) { return Buffer.alloc(0); }
}

// Sortie `--name-status -z` de git → [{ code, oldp, newp }] (R/C portent deux chemins).
function parseNameStatusZ(buf) {
  const specs = [];
  const toks = buf.toString('utf8').split('\0');
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
  return specs;
}

async function gitChanges(root, limit = MAX_FILES) {
  const specs = []; // { code, oldp, newp }
  const ns = await run('git', ['-C', root, 'diff', '--name-status', '-z', 'HEAD'], root);
  if (!ns.failed) specs.push(...parseNameStatusZ(ns.stdout));
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
    const oldBuf = code === 'A' || code === '?' ? Buffer.alloc(0) : await gitShowAt(root, 'HEAD', oldp);
    const newBuf = code === 'D' ? Buffer.alloc(0) : readDisk(path.join(root, newp));
    return makeEntry(root, code === 'D' ? oldp : newp, GIT_STATUS[code] || 'changed', textOrNull(oldBuf), textOrNull(newBuf));
  }));
  return out;
}

// Arbre vide canonique de git — parent de substitution pour diff-er un commit racine.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Diff git entre deux révisions arbitraires (from → to) — brique commune du diff d'un commit
// (parent → commit) et du diff de branche (merge-base → tête de branche).
async function gitRangeChanges(root, from, to, limit = MAX_FILES) {
  const ns = await run('git', ['-C', root, 'diff', '--name-status', '-z', '-M', from, to], root);
  if (ns.failed) return [];
  const specs = parseNameStatusZ(ns.stdout).slice(0, limit);
  return Promise.all(specs.map(async ({ code, oldp, newp }) => {
    const oldBuf = code === 'A' ? Buffer.alloc(0) : await gitShowAt(root, from, oldp);
    const newBuf = code === 'D' ? Buffer.alloc(0) : await gitShowAt(root, to, newp);
    return makeEntry(root, code === 'D' ? oldp : newp, GIT_STATUS[code] || 'changed', textOrNull(oldBuf), textOrNull(newBuf));
  }));
}

// Premier parent de `rev`, ou l'arbre vide pour un commit racine — l'état d'où part le diff
// d'un commit (ou d'une sélection de commits, cf. resolveCommitRange).
async function gitParentRev(root, rev) {
  const pr = await run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', rev + '^'], root);
  return pr.failed ? EMPTY_TREE : pr.stdout.toString('utf8').trim();
}

const JJ_STATUS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied' };

// Contenu d'un fichier à un revset jj donné (@- = parent de la copie de travail). Vide si absent.
async function jjShowAt(root, revset, relPath) {
  const r = await run('jj', ['file', 'show', '-r', revset, relPath], root);
  return r.failed ? Buffer.alloc(0) : r.stdout;
}

// Sortie `jj diff --summary` → [{ code, p }].
function parseJjSummary(buf) {
  const specs = [];
  for (const line of buf.toString('utf8').split('\n')) {
    const m = line.match(/^([A-Z])\s+(.+)$/);
    if (m) specs.push({ code: m[1], p: m[2].trim() });
  }
  return specs;
}

async function jjChanges(root, limit = MAX_FILES) {
  const sum = await run('jj', ['diff', '--summary'], root);
  if (sum.failed) return [];
  const capped = parseJjSummary(sum.stdout).slice(0, limit);
  const out = await Promise.all(capped.map(async ({ code, p }) => {
    const oldBuf = code === 'A' ? Buffer.alloc(0) : await jjShowAt(root, '@-', p);
    const newBuf = code === 'D' ? Buffer.alloc(0) : readDisk(path.join(root, p));
    return makeEntry(root, p, JJ_STATUS[code] || 'changed', textOrNull(oldBuf), textOrNull(newBuf));
  }));
  return out;
}

// Diff jj entre deux revsets arbitraires (from → to) — pendant jj de gitRangeChanges.
async function jjRangeChanges(root, from, to, limit = MAX_FILES) {
  const sum = await run('jj', ['diff', '--summary', '--from', from, '--to', to], root);
  if (sum.failed) return [];
  const capped = parseJjSummary(sum.stdout).slice(0, limit);
  return Promise.all(capped.map(async ({ code, p }) => {
    const oldBuf = code === 'A' ? Buffer.alloc(0) : await jjShowAt(root, from, p);
    const newBuf = code === 'D' ? Buffer.alloc(0) : await jjShowAt(root, to, p);
    return makeEntry(root, p, JJ_STATUS[code] || 'changed', textOrNull(oldBuf), textOrNull(newBuf));
  }));
}

// Every repo detected for a cwd — primary (if any) first, then nested sub-repos scanned
// under the base (primary root, or cwd for a plain "workspace of clones" dir — never above,
// so a cwd inside a sub-repo won't pull in a versioned $HOME or sibling repos).
// { base, list:[{ kind, mechanism, root, primary }] }. Shared by buildVcsChanges and by the
// commit endpoints, which validate a client-supplied repo root against this list.
async function computeRepos(cwd) {
  if (!cwd) return { base: null, list: [] };
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

  return { base, list: primary ? [{ ...primary, primary: true }, ...subs] : subs };
}

// Cache TTL de la détection de dépôts. Elle coûte deux spawns (`git rev-parse`, `.gitmodules`)
// PLUS un parcours `readdirSync` SYNCHRONE de l'arbre de travail (jusqu'à SCAN_MAX_DIRS
// répertoires) — donc elle bloque l'event loop. Or elle est rejouée à chaque appel : une fois
// par diff, mais surtout une fois par SURVOL DE LIGNE via /api/session/vcs-blame. Mesuré sur ce
// dépôt : `git rev-parse` seul ≈ 19 ms, là où le `git grep` d'un symbole en coûte 32.
//
// TTL simple, et pas une invalidation au mtime de `<root>/.git` : créer `pkg/x/.git` ne touche
// pas le `.git` de la racine, c'est-à-dire précisément l'axe qu'explore scanSubRepos. Même
// arbitrage que le cache de listing de files.js, pour la même raison — un parcours complet est
// trop cher pour être refait à chaque frappe. Un dépôt apparu ou disparu est donc vu avec au
// plus REPOS_TTL de retard, ce qui est sans conséquence : les diffs sont déjà rechargés à la
// demande, et le bouton Refresh de la lentille Ship force le rechargement.
//
// Le résultat est PARTAGÉ entre appelants : aucun ne mute `list` (les quatre sites de vcsDiff /
// vcsBlame ne font que le lire, le `.sort()` de vcsBlame:98 portant sur le tableau frais rendu
// par `.filter()`). Ne pas muter la valeur rendue.
const REPOS_TTL = 10000;
const reposCache = new Map();   // cwd -> { at, value }
const reposInFlight = new Map(); // cwd -> promise — deux survols dans le même tick = un seul scan

async function detectRepos(cwd) {
  if (!cwd) return { base: null, list: [] };
  const hit = reposCache.get(cwd);
  if (hit && Date.now() - hit.at < REPOS_TTL) return hit.value;
  const flying = reposInFlight.get(cwd);
  if (flying) return flying;
  const p = computeRepos(cwd)
    .then((value) => { reposCache.set(cwd, { at: Date.now(), value }); return value; })
    .finally(() => reposInFlight.delete(cwd)); // un échec ne doit pas rester collé en cache
  reposInFlight.set(cwd, p);
  return p;
}

// Repo whose commits are requested: the client-supplied root must be one of the DETECTED
// repos (never an arbitrary path), else fall back to the primary (first) repo.
async function resolveRepo(cwd, repoRoot) {
  const { list } = await detectRepos(cwd);
  if (!list.length) return null;
  if (repoRoot) return list.find((r) => r.root === repoRoot) || null;
  return list[0];
}

// { vcs, root, changes, truncated, repos:[{ kind, root, label, primary, changes }] }.
// `repos` lists every detected repo, primary first when it exists. Top-level vcs/root/changes
// keep mirroring the primary repo. MAX_FILES is a global budget: repos past it stay listed
// with empty changes and `truncated` flips to true.
async function buildVcsChanges(cwd) {
  const empty = { vcs: null, root: null, changes: [], truncated: false, repos: [] };
  if (!cwd) return empty;
  const { base, list } = await detectRepos(cwd);
  if (!list.length) return empty;
  const primary = list[0].primary ? list[0] : null;

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

// Révision hexadécimale telle qu'émise par parseLogLines. Valider AVANT de la passer en argv :
// exclut aussi toute chaîne commençant par '-' (injection de flag) ou un revset arbitraire.
const REV_RE = /^[0-9a-f]{4,64}$/i;

// Un commit par ligne, champs séparés par des tabulations et SUJET EN DERNIER (il peut en
// contenir — on re-joint le reste). Même disposition des deux côtés, donc un seul analyseur.
const GIT_LOG_FMT = '%H%x09%an%x09%aI%x09%s';
const JJ_LOG_TPL = 'commit_id ++ "\\t" ++ author.name() ++ "\\t" ++ author.timestamp() ++ "\\t" ++ description.first_line() ++ "\\n"';

function parseLogLines(buf) {
  const commits = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue;
    const [rev, author, ts, ...rest] = line.split('\t');
    if (rev && REV_RE.test(rev)) commits.push({ rev, author: author || '', ts: ts || '', subject: rest.join('\t') });
  }
  return commits;
}

// ── diff de branche (lentille Branch) ───────────────────────────────────────────────────────

const BRANCH_MAX = 100; // branches listées pour le sélecteur
// Nom de branche/bookmark tel qu'on accepte de le passer en argv : jamais de '-' initial
// (injection de flag) ni d'espaces/méta-caractères de revset. Les noms exotiques sont
// simplement absents du sélecteur.
const BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const BRANCH_LOG_MAX = 100; // commits offered by the lens' commit picker

// The branch's own commits (those `from` — its fork point — does not carry), newest first.
// Feeds the commit picker of the Branch lens, and is the ONLY set a client selection may name.
async function branchCommits(root, mechanism, from, branch) {
  const r = mechanism === 'git'
    ? await run('git', ['-C', root, 'log', '-n', String(BRANCH_LOG_MAX), '--format=' + GIT_LOG_FMT, `${from}..${branch}`], root)
    : await run('jj', ['log', '-n', String(BRANCH_LOG_MAX), '--no-graph', '-r', `"${from}".."${branch}"`, '-T', JJ_LOG_TPL], root);
  return r.failed ? [] : parseLogLines(r.stdout);
}

// Which commits of the branch to diff, from a client selection — reviewing a branch one chunk
// at a time instead of all at once. Both ends must be commits of THIS branch (never an
// arbitrary revision), the pair is normalised (`from` = the oldest, `to` = the newest) so the
// caller may hand them in either order, and the selection is INCLUSIVE: the diff starts at the
// parent of `from`. Null (whole branch) as soon as anything does not check out.
// { from, to, parent } — `parent` is the revision the diff actually starts from.
async function resolveCommitRange(root, mechanism, commits, range) {
  if (!range || !range.from || !range.to) return null;
  const i = commits.findIndex((c) => c.rev === range.from);
  const j = commits.findIndex((c) => c.rev === range.to);
  if (i < 0 || j < 0) return null;
  const from = commits[Math.max(i, j)].rev;
  const to = commits[Math.min(i, j)].rev;
  return { from, to, parent: mechanism === 'git' ? await gitParentRev(root, from) : from + '-' };
}

// Branches locales d'UN dépôt de la session (principal par défaut, ou `repoRoot` parmi les
// dépôts détectés). { vcs, root, branches:[{ name, current }], default, repos:[{ kind, root,
// label, primary }] }. `default` = la branche de référence proposée comme base du diff
// (origin/HEAD, sinon main/master, sinon la branche courante). `repos` alimente le sélecteur
// de dépôt du front (mêmes labels que buildVcsChanges).
async function listVcsBranches(cwd, repoRoot = null, limit = BRANCH_MAX) {
  const empty = { vcs: null, root: null, branches: [], default: null, repos: [] };
  if (!cwd) return empty;
  const { base, list } = await detectRepos(cwd);
  if (!list.length) return empty;
  const repo = (repoRoot && list.find((r) => r.root === repoRoot)) || list[0];
  const repos = list.map((r) => ({ kind: r.kind, root: r.root, label: r.primary ? '' : path.relative(base, r.root), primary: r.primary }));
  const { root, kind, mechanism } = repo;

  const branches = [];
  let def = null;
  if (mechanism === 'git') {
    const r = await run('git', ['-C', root, 'for-each-ref', 'refs/heads', '--sort=-committerdate',
      '--format=%(refname:short)\t%(HEAD)', '--count', String(limit)], root);
    if (!r.failed) {
      for (const line of r.stdout.toString('utf8').split('\n')) {
        if (!line) continue;
        const [name, head] = line.split('\t');
        if (name && BRANCH_RE.test(name)) branches.push({ name, current: head === '*' });
      }
    }
    // Base par défaut : la branche que origin/HEAD désigne, sinon main/master locale.
    const oh = await run('git', ['-C', root, 'symbolic-ref', '--short', '--quiet', 'refs/remotes/origin/HEAD'], root);
    if (!oh.failed) {
      const name = oh.stdout.toString('utf8').trim().replace(/^origin\//, '');
      if (branches.some((b) => b.name === name)) def = name;
    }
  } else {
    const r = await run('jj', ['bookmark', 'list', '-T', 'name ++ "\\n"'], root);
    if (!r.failed) {
      for (const name of r.stdout.toString('utf8').split('\n')) {
        if (name && BRANCH_RE.test(name)) branches.push({ name, current: false });
        if (branches.length >= limit) break;
      }
    }
  }
  if (!def) def = ['main', 'master', 'trunk'].find((n) => branches.some((b) => b.name === n)) || null;
  if (!def) def = (branches.find((b) => b.current) || branches[0] || {}).name || null;
  return { vcs: kind, mechanism, root, branches, default: def, repos };
}

// Diff COMPLET d'une branche : tout ce que `branch` apporte par rapport à `base` — la somme des
// commits de la branche depuis son point de fork, comme la vue « Files changed » d'une PR.
// Cas piège : une branche DÉJÀ MERGÉE dans la base est un ancêtre de la base → son merge-base
// est sa propre tête et le diff naïf est vide. On retrouve alors le diff historique via le
// commit de merge (diff fork-point → tête, fork-point = merge-base du 1er parent du merge) et
// on pose `merged:true`. `branch` et `base` sont re-validés contre la liste des branches du
// dépôt — jamais une révision arbitraire du client.
// `range` ({ from, to }, two commits of the branch) narrows the diff to those commits only —
// the rest of the branch is left out, but `commits` still lists it whole so the picker never
// collapses on a selection.
// { vcs, root, branch, base, mergeBase, merged, commits, range, changes }.
async function buildVcsBranchChanges(cwd, branch, baseBranch = null, repoRoot = null, range = null) {
  const empty = { vcs: null, root: null, branch: null, base: null, mergeBase: null, merged: false, commits: [], range: null, changes: [] };
  if (!cwd || typeof branch !== 'string' || !BRANCH_RE.test(branch)) return empty;
  const listed = await listVcsBranches(cwd, repoRoot);
  if (!listed.root) return empty;
  const has = (n) => listed.branches.some((b) => b.name === n);
  if (!has(branch)) return empty;
  const base = (baseBranch && BRANCH_RE.test(baseBranch) && has(baseBranch)) ? baseBranch : listed.default;
  if (!base) return empty;
  const { root, vcs, mechanism } = listed;

  let mergeBase = null;
  let merged = false;
  let commits = [];
  let picked = null;
  let changes = [];
  if (mechanism === 'git') {
    const mb = await run('git', ['-C', root, 'merge-base', base, branch], root);
    mergeBase = mb.failed ? null : mb.stdout.toString('utf8').trim() || null;
    const tipR = await run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', branch], root);
    const tip = tipR.failed ? null : tipR.stdout.toString('utf8').trim();
    if (mergeBase && tip && mergeBase === tip) {
      // Branche déjà mergée. Chercher dans la base le commit de merge dont la tête de branche
      // est un parent (du plus récent au plus ancien) et re-calculer le fork-point depuis son
      // PREMIER parent (l'état de la base au moment du merge). Squash/fast-forward : pas de
      // commit de merge retrouvable → le diff reste vide, `merged` l'explique au front.
      merged = true;
      const ml = await run('git', ['-C', root, 'rev-list', '--merges', '--parents', '-n', '1000', base], root);
      if (!ml.failed) {
        for (const line of ml.stdout.toString('utf8').split('\n')) {
          const p = line.trim().split(/\s+/); // [merge, parent1, parent2, …]
          if (p.length >= 3 && p.slice(2).includes(tip)) {
            const hb = await run('git', ['-C', root, 'merge-base', p[1], tip], root);
            const fork = hb.failed ? null : hb.stdout.toString('utf8').trim();
            if (fork) mergeBase = fork;
            break;
          }
        }
      }
    }
    // Sans merge-base (historiques sans lien), le fork est la base elle-même.
    const fork = mergeBase || base;
    commits = await branchCommits(root, 'git', fork, branch);
    picked = await resolveCommitRange(root, 'git', commits, range);
    changes = picked
      ? await gitRangeChanges(root, picked.parent, picked.to)
      : await gitRangeChanges(root, fork, branch);
  } else {
    commits = await branchCommits(root, 'jj', base, branch);
    picked = await resolveCommitRange(root, 'jj', commits, range);
    if (picked) {
      changes = await jjRangeChanges(root, picked.parent, picked.to);
    } else {
      // Ancêtre commun en revset jj ; s'il n'est pas unique (--from exige UNE révision),
      // retomber sur la base elle-même.
      const from = `heads(::"${base}" & ::"${branch}")`;
      changes = await jjRangeChanges(root, from, `"${branch}"`);
      if (!changes.length) changes = await jjRangeChanges(root, `"${base}"`, `"${branch}"`);
    }
  }
  return { vcs, root, branch, base, mergeBase, merged, commits, range: picked, changes };
}

export { detectVcs, detectRepos, scanSubRepos, buildVcsChanges, listVcsBranches, buildVcsBranchChanges };
