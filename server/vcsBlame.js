/*
 * Blame d'un fichier — « qui a écrit cette ligne ? » sous le curseur, dans les diffs des
 * lentilles Ship et Branch.
 *
 * Un seul mécanisme : `git blame --porcelain`. Les dépôts jj colocatés passent par git comme
 * partout ailleurs (cf. vcsDiff.js) ; un jj NON colocaté renvoie `supported:false` et le front
 * n'affiche simplement rien.
 *
 * Sécurité : execFile('git', [...]) — jamais de shell. Le chemin du client est re-résolu contre
 * les dépôts DÉTECTÉS de la session (jamais un chemin arbitraire), et la révision doit passer
 * REV_RE / BRANCH_RE (donc pas de '-' initial : aucune injection de flag).
 *
 * Sortie compacte, la métadonnée de commit étant partagée par toutes les lignes qu'il porte :
 *   { supported, root, rev, commits:[{ rev, author, mail, time, summary, uncommitted }],
 *     lines:[{ c: <index dans commits>, t: <texte de la ligne> }] }
 * `t` permet au front de VÉRIFIER que la ligne blamée est bien celle qu'il affiche (le diff peut
 * porter un contenu plus récent que la révision blamée) et de ne rien afficher sinon.
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { detectRepos } from './vcsDiff.js';

const TIMEOUT = 20000;
const MAX_LINES = 20000;      // au-delà, on ne blame pas (fichier généré / minifié)
const CACHE_MAX = 40;         // blames mémorisés (LRU grossier)

// Révision acceptable en argv : sha, nom de branche/bookmark, avec un `^` final optionnel
// (le parent d'un commit, côté « old » du diff d'un commit).
const REV_OK = /^(?:[0-9a-f]{4,64}|[A-Za-z0-9_][A-Za-z0-9._/-]*)\^?$/;

function run(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: TIMEOUT, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve({ failed: !!err, out: stdout || '' });
    });
  });
}

// `git blame --porcelain` : un en-tête « <sha> <ligne-orig> <ligne-finale> [n] » par ligne, les
// champs du commit (author, summary…) une seule fois par sha, puis la ligne elle-même préfixée
// d'une TABULATION. On indexe par numéro de ligne FINAL (celui du fichier blamé).
function parsePorcelain(out) {
  const meta = new Map();      // sha -> { author, mail, time, summary }
  const order = [];            // sha dans l'ordre de première apparition
  const byLine = [];           // ligne (1-based) -> { sha, text }
  let cur = null;
  for (const line of out.split('\n')) {
    if (cur && line[0] === '\t') {
      byLine[cur.final] = { sha: cur.sha, text: line.slice(1) };
      cur = null;
      continue;
    }
    const h = line.match(/^([0-9a-f]{7,64}) \d+ (\d+)(?: \d+)?$/);
    if (h) {
      cur = { sha: h[1], final: Number(h[2]) };
      if (!meta.has(cur.sha)) { meta.set(cur.sha, { author: '', mail: '', time: 0, summary: '' }); order.push(cur.sha); }
      continue;
    }
    if (!cur) continue;
    const m = meta.get(cur.sha);
    if (line.startsWith('author ')) m.author = line.slice(7);
    else if (line.startsWith('author-mail ')) m.mail = line.slice(12).replace(/^<|>$/g, '');
    else if (line.startsWith('author-time ')) m.time = Number(line.slice(12)) || 0;
    else if (line.startsWith('summary ')) m.summary = line.slice(8);
  }

  const idx = new Map(order.map((sha, i) => [sha, i]));
  const commits = order.map((sha) => {
    const m = meta.get(sha);
    // Ligne encore dans l'arbre de travail : git la porte par un sha tout à zéro et l'auteur
    // littéral « Not Committed Yet ».
    const uncommitted = /^0+$/.test(sha);
    return { rev: sha.slice(0, 8), author: m.author, mail: m.mail, time: m.time, summary: m.summary, uncommitted };
  });
  const lines = [];
  for (let i = 1; i < byLine.length; i++) {
    const b = byLine[i];
    lines[i - 1] = b ? { c: idx.get(b.sha), t: b.text } : null;
  }
  return { commits, lines };
}

const cache = new Map(); // `${root}\0${rev}\0${rel}` -> { key, value }

// Blame d'un fichier d'un dépôt de la session. `file` est un chemin ABSOLU (celui que le front
// reçoit dans les entrées de diff) ; `rev` vide = arbre de travail.
async function buildVcsBlame(cwd, file, rev = '') {
  const empty = { supported: false, root: null, rev: null, commits: [], lines: [] };
  if (!cwd || typeof file !== 'string' || !path.isAbsolute(file)) return empty;
  const ref = typeof rev === 'string' ? rev.trim() : '';
  if (ref && !REV_OK.test(ref)) return empty;

  const abs = path.resolve(file);
  const { list } = await detectRepos(cwd);
  // Le dépôt le plus SPÉCIFIQUE contenant le fichier (dépôt imbriqué avant le principal).
  const repo = list
    .filter((r) => r.mechanism === 'git' && (abs === r.root || abs.startsWith(r.root + path.sep)))
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (!repo) return empty;

  const rel = path.relative(repo.root, abs);
  const key = `${repo.root}\0${ref}\0${rel}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const args = ['-C', repo.root, 'blame', '--porcelain', '--no-progress'];
  if (ref) args.push(ref);
  args.push('--', rel);
  const r = await run(args, repo.root);
  if (r.failed) return { ...empty, supported: true, root: repo.root, rev: ref || null };

  const parsed = parsePorcelain(r.out);
  const out = parsed.lines.length > MAX_LINES
    ? { supported: true, root: repo.root, rev: ref || null, commits: [], lines: [] }
    : { supported: true, root: repo.root, rev: ref || null, ...parsed };

  // Un blame d'arbre de travail se périme dès la prochaine édition : on ne le mémorise pas.
  if (ref) {
    cache.set(key, out);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return out;
}

export { buildVcsBlame };
