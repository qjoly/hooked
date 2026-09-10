/* Résolution heuristique d'un symbole → sa déclaration probable, pour le « go to definition »
 * de la review (⌘-clic sur un nom de type / de fonction / de méthode).
 *
 * Pas de LSP, pas de tree-sitter, pas d'index : `git grep` fournit les OCCURRENCES, et tout le
 * discernement se fait ensuite en JS sur le texte des lignes. Ce partage est délibéré —
 * l'étape git reste une recherche LITTÉRALE (`-F -w`), donc insensible au dialecte de regex de
 * la plateforme, et l'étape intelligente est pure, testable et débogable.
 *
 * Le module est exposé NAMESPACÉ par le barrel (`export * as symbols`) : ses noms (`lookup`,
 * `partition`, `readSlice`) sont trop génériques pour un `export *`, où une collision fait
 * disparaître un symbole en silence. Cf. searchIndex.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { detectRepos } from './vcsDiff.js';
import { FILE_IGNORE, listFilesUnder } from './files.js';
import { declarationKind, langOfPath } from '../src/lib/localDefs.js';

const SYMBOL_RE = /^[A-Za-z_$][\w$]{0,127}$/;
// Même grammaire que vcsBlame : SHA, `HEAD`, `SHA^`, ou un NOM DE BRANCHE — la lentille Branch
// blâme et résout à `mergeBase → branch`, pas à des SHA (cf. Branch.svelte:130-138).
const REV_OK = /^(?:[0-9a-f]{4,64}|[A-Za-z0-9_][A-Za-z0-9._/-]*)\^?$/;

const DEADLINE_MS = 5000;      // budget de la REQUÊTE, tous dépôts confondus (cf. lookup)
const MIN_SPAWN_MS = 500;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_OUT = 8;             // déclarations / références rendues
const WINDOW_MAX = 400;        // lignes par appel de readSlice
const SLICE_MAX_BYTES = 2 * 1024 * 1024;
const SCAN_MAX_BYTES = 32 * 1024 * 1024;  // budget du repli hors git

// ── exécution ────────────────────────────────────────────────────────────────────────────
// Runner local plutôt que le `run()` de vcsDiff : celui-ci a `timeout: 20000` EN DUR, ce qui
// est un budget de tâche de fond, pas d'un geste interactif. On n'élargit pas la signature
// d'un helper partagé pour un seul appelant.
function git(root, args, timeout) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, timeout, maxBuffer: MAX_BUFFER, encoding: 'buffer' },
      (err, stdout) => resolve({
        failed: !!err,
        timedOut: !!(err && err.killed),
        truncated: !!(err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'),
        stdout: stdout || Buffer.alloc(0),
      }));
  });
}

// ── le format de sortie de `git grep -z` EST le contrat ──────────────────────────────────
// Mesuré (git 2.55) : `path \0 line \0 content \n`, et à une révision le chemin est PRÉFIXÉ
// `<rev>:`. Lecture SÉQUENTIELLE, jamais un split('\n') : un nom de fichier peut légalement
// contenir un saut de ligne — c'est précisément pourquoi `-z` termine le chemin par un NUL.
export function parseGrep(buf, rev) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  const prefix = rev ? rev + ':' : '';
  const out = [];
  let i = 0;
  while (i < s.length) {
    const p1 = s.indexOf('\0', i);
    if (p1 < 0) break;
    const p2 = s.indexOf('\0', p1 + 1);
    if (p2 < 0) break;
    let nl = s.indexOf('\n', p2 + 1);
    if (nl < 0) nl = s.length;
    let rel = s.slice(i, p1);
    if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
    const line = Number(s.slice(p1 + 1, p2));
    if (rel && Number.isFinite(line)) out.push({ rel, line, text: s.slice(p2 + 1, nl) });
    i = nl + 1;
  }
  return out;
}

// Exclusions de chemins — utiles UNIQUEMENT avec --untracked : sans lui, `git grep` ne voit que
// les fichiers SUIVIS, donc node_modules est déjà hors jeu. Et `:!node_modules` ne suffirait
// pas, il ne matche que la racine (mesuré : pkg/sub/node_modules/ passait au travers).
const EXCLUDES = [...FILE_IGNORE]
  .filter((d) => !d.startsWith('.') && d !== 'tmp')
  .map((d) => `:(glob,exclude)**/${d}/**`);

async function grepRepo(root, symbol, rev, deadline) {
  const timeout = Math.max(MIN_SPAWN_MS, deadline - Date.now());
  // -F est OBLIGATOIRE : sans lui le motif est une BRE et un identifiant terminé par `$`
  // (`data$`, `destroy$`) transforme le `$` en ancre — mesuré, zéro résultat. -F et -w sont
  // tous deux gérés PAR GIT : la commande devient insensible au dialecte de regex local.
  // `-e <symbole>` puis `--` : un symbole ne peut jamais être pris pour un flag.
  const base = ['grep', '-I', '-z', '-n', '-w', '-F', '--no-color', '-e', symbol];
  // --untracked et <rev> sont exclusifs (`fatal: <rev>: no such path in the working tree`).
  const args = rev ? [...base, rev, '--'] : [...base, '--untracked', '--', ...EXCLUDES];
  const r = await git(root, args, timeout);
  return { hits: parseGrep(r.stdout, rev), timedOut: r.timedOut, truncated: r.truncated };
}

// ── repli hors git ───────────────────────────────────────────────────────────────────────
// jj n'a pas de grep (et la lentille Branch désactive déjà le blame pour jj). Un dépôt jj
// colocalisé garde mechanism:'git' et passe par le chemin rapide ; ici c'est le vrai repli.
function scanRepo(root, symbol, deadline) {
  const word = new RegExp(`(?<![\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
  const hits = [];
  let bytes = 0;
  for (const rel of listFilesUnder(root)) {
    if (Date.now() > deadline || bytes > SCAN_MAX_BYTES) return { hits, timedOut: true, truncated: true };
    if (!langOfPath(rel)) continue;
    let txt;
    try { txt = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { continue; }
    bytes += txt.length;
    if (!txt.includes(symbol)) continue;
    const lines = txt.split('\n');
    for (let i = 0; i < lines.length; i++) if (word.test(lines[i])) hits.push({ rel, line: i + 1, text: lines[i] });
  }
  return { hits, timedOut: false, truncated: false };
}

// ── imports du fichier cliqué (JS/TS seulement) ──────────────────────────────────────────
// Sert à deux choses : classer plus haut un candidat vivant dans un fichier que celui-ci
// importe, et répondre « ce symbole vient de <paquet> » quand aucune déclaration n'existe —
// ce qui transforme le cas d'échec le plus fréquent en information.
// Limité à JS/TS assumé : l'écrire pour sept langages (plus la résolution des specifiers)
// est un projet en soi, et les autres langages gardent tous les autres critères de tri.
const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

export function parseImports(text) {
  const bySymbol = new Map();  // nom local -> specifier
  const specifiers = [];
  if (typeof text !== 'string') return { bySymbol, specifiers };
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(text))) {
    const spec = m[2] || m[3];
    if (!spec) continue;
    specifiers.push(spec);
    const clause = m[1] || '';
    const braces = /\{([\s\S]*?)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) bySymbol.set(name, spec);
      }
    }
    const bare = clause.replace(/\{[\s\S]*?\}/, '').replace(/\*\s*as\s+/, '').split(',');
    for (const part of bare) {
      const name = part.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) bySymbol.set(name, spec);
    }
  }
  return { bySymbol, specifiers };
}

// Un candidat vit-il dans un fichier importé par le fichier cliqué ? On compare des chemins
// SANS résoudre l'extension : `./x` doit couvrir `x.js`, `x.ts`, `x.svelte`, `x/index.js`.
function importedRels(clickRel, specifiers) {
  const dir = path.posix.dirname(clickRel);
  const out = [];
  for (const spec of specifiers) {
    if (!spec.startsWith('.')) continue;
    out.push(path.posix.normalize(path.posix.join(dir, spec)));
  }
  return out;
}
const coversRel = (bases, rel) => bases.some((b) => rel === b || rel.startsWith(b + '.') || rel.startsWith(b + '/index.'));

// ── partition ────────────────────────────────────────────────────────────────────────────
// Pas de somme de poids arbitraires : une partition, puis des comparateurs ORDONNÉS. Chaque
// comparateur produit aussi le `reason` affiché — le tri et son explication sont la même
// donnée, elles ne peuvent pas diverger.
const isTestPath = (rel) => /(^|\/)(?:tests?|__tests__|spec)\//.test(rel) || /\.(?:test|spec)\.[\w]+$/.test(rel);
const isBuiltPath = (rel) => /(^|\/)(?:dist|build|vendor|out)\//.test(rel) || /\.min\.|\.generated\./.test(rel);
const isDts = (rel) => rel.endsWith('.d.ts');

export function partition(symbol, candidates, ctx = {}) {
  const { clickRel = '', clickLineText = '', importedBases = [], isTestClick = false } = ctx;
  const clickTrim = clickLineText.trim();
  const decls = [], refs = [];

  for (const c of candidates) {
    // On exclut le SITE DU CLIC par comparaison de TEXTE, pas de numéro : les numéros affichés
    // dans un diff d'op `edit` sont relatifs au fragment, pas au fichier.
    if (c.rel === clickRel && clickTrim && c.text.trim() === clickTrim) continue;
    const kind = declarationKind(c.text, langOfPath(c.rel), symbol);
    (kind ? decls : refs).push({ ...c, kind: kind || null });
  }

  const hasPlainDts = decls.some((d) => !isDts(d.rel));
  const clickDir = path.posix.dirname(clickRel);
  const score = (d) => {
    const reasons = [];
    let rank = 0;
    if (coversRel(importedBases, d.rel)) { rank -= 6; reasons.push('imported by this file'); }
    if (d.rel === clickRel) { rank -= 5; reasons.push('same file'); }
    if (/^\s*(?:export|pub\b|public\b)/.test(d.text)) { rank -= 3; reasons.push('exported'); }
    if (clickRel && path.posix.dirname(d.rel) === clickDir) { rank -= 2; reasons.push('same directory'); }
    if (isTestPath(d.rel) && !isTestClick) { rank += 6; reasons.push('in a test'); }
    if (isBuiltPath(d.rel)) { rank += 5; reasons.push('generated or vendored'); }
    if (isDts(d.rel) && hasPlainDts) { rank += 3; reasons.push('type declaration only'); }
    // `demoted` : le candidat matche un motif de déclaration mais un critère NÉGATIF l'a
    // rétrogradé (binding local d'un test, fichier généré…). Il reste affichable, il ne peut
    // simplement pas gagner tout seul le droit d'ouvrir directement.
    return { rank, demoted: rank > 0, reason: reasons.join(', ') || `${d.kind} declaration` };
  };

  for (const d of decls) Object.assign(d, score(d));
  decls.sort((a, b) => a.rank - b.rank || a.rel.length - b.rel.length || a.line - b.line);
  refs.sort((a, b) => a.rel.length - b.rel.length || a.line - b.line);
  return { declarations: decls, references: refs };
}

// ── garde de chemin ──────────────────────────────────────────────────────────────────────
// Modèle calqué sur readScreenshot (server/screenshots.js), le précédent le plus strict du
// dépôt : realpath AVANT toute comparaison. vcsBlame, lui, ne realpathe pas — ne pas recopier
// cette partie-là. Les `root` de detectRepos viennent de `git rev-parse --show-toplevel`, qui
// renvoie des chemins DÉJÀ résolus : realpather la requête aligne donc les deux mondes (sous
// macOS /var → /private/var, cf. test/vcsDiff.test.mjs).
async function repoOf(cwd, absPath) {
  if (!cwd || typeof absPath !== 'string' || !path.isAbsolute(absPath)) return null;
  let real;
  try { real = fs.realpathSync(path.resolve(absPath)); } catch (_) { return null; }
  const { list } = await detectRepos(cwd);
  const repo = list
    .filter((r) => real === r.root || real.startsWith(r.root + path.sep))
    .sort((a, b) => b.root.length - a.root.length)[0];
  return repo ? { repo, real, rel: path.relative(repo.root, real) } : null;
}

// ── lookup ───────────────────────────────────────────────────────────────────────────────
export async function lookup(cwd, { symbol, file, rev = '' } = {}) {
  const empty = {
    supported: false, root: null, symbol: symbol || '', approximate: false, timedOut: false,
    truncated: false, origin: null, jump: null, declarations: [], references: [], referenceCount: 0,
  };
  if (!SYMBOL_RE.test(String(symbol || ''))) return empty;
  const ref = typeof rev === 'string' ? rev.trim() : '';
  if (ref && !REV_OK.test(ref)) return empty;

  const here = await repoOf(cwd, file);
  const { list } = await detectRepos(cwd);
  if (!list.length) return { ...empty, symbol };

  // Contexte de tri, lu dans le fichier cliqué.
  let clickRel = '', clickText = '', importedBases = [], bySymbol = new Map();
  if (here) {
    clickRel = here.rel;
    try { clickText = fs.readFileSync(here.real, 'utf8'); } catch (_) { /* supprimé entre-temps */ }
    if (langOfPath(clickRel) === 'js') {
      const imp = parseImports(clickText);
      bySymbol = imp.bySymbol;
      importedBases = importedRels(clickRel, imp.specifiers);
    }
  }

  // Un symbole importé d'un PAQUET est tranché avant même de chercher : aucune déclaration
  // locale ne peut être sa définition. Sans cette priorité, cliquer `query` dans agent.js —
  // importé de @anthropic-ai/claude-agent-sdk — renvoyait trois `let query = $state('')`
  // sans rapport, tous parfaitement classés et tous faux.
  const importedFrom = bySymbol.get(symbol);
  if (importedFrom && !importedFrom.startsWith('.')) {
    return { ...empty, supported: true, root: here ? here.repo.root : list[0].root, symbol,
             origin: { kind: 'dependency', specifier: importedFrom } };
  }

  // Le dépôt le PLUS SPÉCIFIQUE contenant le fichier cliqué d'abord, les autres seulement si
  // rien n'a été trouvé. Une échéance GLOBALE, pas un timeout par spawn : dix dépôts à 5 s
  // chacun feraient 50 s là où le contrat annonce 5.
  const deadline = Date.now() + DEADLINE_MS;
  const ordered = here ? [here.repo, ...list.filter((r) => r.root !== here.repo.root)] : list;

  let declarations = [], references = [], refCount = 0, timedOut = false, truncated = false, root = null;
  for (const repo of ordered) {
    if (Date.now() >= deadline) { timedOut = true; break; }
    const inThisRepo = here && repo.root === here.repo.root;
    const res = repo.mechanism === 'git'
      ? await grepRepo(repo.root, symbol, inThisRepo ? ref : '', deadline)
      : scanRepo(repo.root, symbol, deadline);
    timedOut = timedOut || res.timedOut;
    truncated = truncated || res.truncated;
    const part = partition(symbol, res.hits, {
      clickRel: inThisRepo ? clickRel : '',
      clickLineText: '',
      importedBases: inThisRepo ? importedBases : [],
      isTestClick: isTestPath(clickRel),
    });
    const abs = (h) => ({ ...h, file: path.join(repo.root, h.rel), root: repo.root });
    refCount += part.references.length;
    if (part.declarations.length) {
      root = repo.root;
      declarations = part.declarations.map(abs);
      references = part.references.slice(0, MAX_OUT).map(abs);
      break;
    }
    if (!references.length) { root = repo.root; references = part.references.slice(0, MAX_OUT).map(abs); }
  }

  // Ouverture DIRECTE si et seulement s'il reste une unique déclaration non rétrogradée.
  // Règle catégorielle, sans seuil à régler : `buildVcsChanges` a bien deux déclarations,
  // mais la seconde est un `let x, y, z` de fichier de test — elle ne doit pas empêcher le
  // saut. La décision vit ICI, pas dans l'UI, pour être testable sans navigateur.
  const primary = declarations.filter((d) => !d.demoted);
  const jump = primary.length === 1 ? primary[0] : null;

  return {
    jump,
    supported: true,
    root: root || list[0].root,
    symbol,
    // Côté suppression d'un diff Claude il n'y a pas de révision (blameFor rend old:null) :
    // on résout dans l'arbre de travail, et on le DIT.
    approximate: !ref && !!rev,
    timedOut, truncated, origin: null,   // le seul cas non-null est tranché plus haut
    declarations: declarations.slice(0, MAX_OUT),
    references: declarations.length ? [] : references,
    referenceCount: refCount,
  };
}

// ── readSlice ────────────────────────────────────────────────────────────────────────────
export async function readSlice(cwd, { file, rev = '', from = 0, to = 0 } = {}) {
  const empty = { supported: false, root: null, rel: null, lang: null, from: 0, to: 0, total: 0, truncated: false, lines: [] };
  const ref = typeof rev === 'string' ? rev.trim() : '';
  if (ref && !REV_OK.test(ref)) return empty;
  const at = await repoOf(cwd, file);
  if (!at) return empty;

  let text;
  if (ref) {
    const r = await git(at.repo.root, ['show', `${ref}:${at.rel}`], DEADLINE_MS);
    if (r.failed) return empty;
    text = r.stdout.slice(0, SLICE_MAX_BYTES).toString('utf8');
  } else {
    try {
      const buf = fs.readFileSync(at.real);
      if (buf.includes(0)) return empty; // binaire
      text = buf.slice(0, SLICE_MAX_BYTES).toString('utf8');
    } catch (_) { return empty; }
  }

  const lines = text.split('\n');
  const total = lines.length;
  const start = Math.max(1, Math.min(Number(from) || 1, total));
  const end = Math.max(start, Math.min(Number(to) || start + WINDOW_MAX - 1, total, start + WINDOW_MAX - 1));
  return {
    supported: true, root: at.repo.root, rel: at.rel, lang: langOfPath(at.rel),
    from: start, to: end, total, truncated: end < total || start > 1,
    lines: lines.slice(start - 1, end),
  };
}
