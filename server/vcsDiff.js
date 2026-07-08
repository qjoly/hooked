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
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { statSafe } from './util.js';

const FILE_MAX = 200000; // cap par côté (old/new) d'un fichier
const MAX_FILES = 60;    // nombre max de fichiers rendus
const TIMEOUT = 20000;

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

async function gitChanges(root) {
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

  const capped = specs.slice(0, MAX_FILES);
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

async function jjChanges(root) {
  const sum = await run('jj', ['diff', '--summary'], root);
  if (sum.failed) return [];
  const specs = [];
  for (const line of sum.stdout.toString('utf8').split('\n')) {
    const m = line.match(/^([A-Z])\s+(.+)$/);
    if (m) specs.push({ code: m[1], p: m[2].trim() });
  }
  const capped = specs.slice(0, MAX_FILES);
  const out = await Promise.all(capped.map(async ({ code, p }) => {
    const oldBuf = code === 'A' ? Buffer.alloc(0) : await jjShowParent(root, p);
    const newBuf = code === 'D' ? Buffer.alloc(0) : readDisk(path.join(root, p));
    return makeEntry(root, p, JJ_STATUS[code] || 'changed', textOrNull(oldBuf), textOrNull(newBuf));
  }));
  return out;
}

// { vcs:'git'|'jj'|null, root, changes:[…] }. vcs=null si le projet n'est sous aucun VCS connu.
async function buildVcsChanges(cwd) {
  const info = await detectVcs(cwd);
  if (!info) return { vcs: null, root: null, changes: [] };
  const changes = info.mechanism === 'jj' ? await jjChanges(info.root) : await gitChanges(info.root);
  return { vcs: info.kind, root: info.root, changes };
}

export { detectVcs, buildVcsChanges };
