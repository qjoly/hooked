// Coloration syntaxique légère et sans dépendance.
//
// Un seul moteur (scanTokens) piloté par des tables de règles par langage. Chaque
// règle = [classe, regex collante (flag `y`)]. À chaque position on essaie les
// règles dans l'ordre ; la première qui matche au curseur gagne. Tout ce qui
// n'est reconnu par aucune règle est échappé caractère par caractère.
//
// Les classes produites (`hl-com`, `hl-str`, …) sont stylées dans app.css.
//
// Le découpage sert DEUX consommateurs : `highlight()` (rendu HTML) et `symbolAt()` (le
// symbole sous le curseur, pour le « go to definition »). Toute modification de scanTokens
// est couverte au caractère près par test/highlightBaseline.test.mjs.

import { esc } from './format.js';

// règles communes (instances réutilisées : lastIndex est repositionné à chaque exec).
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//y;
const LINE_SLASH = /\/\/[^\n]*/y;
const LINE_HASH = /#[^\n]*/y;
const STR_D = /"(?:\\.|[^"\\])*"/y;
const STR_S = /'(?:\\.|[^'\\])*'/y;
const STR_T = /`(?:\\[\s\S]|[^`\\])*`/y;
const NUMBER = /0[xX][\da-fA-F_]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?|\.\d+/y;
const IDENT = /[A-Za-z_$][\w$]*/y;
const set = (s) => new Set(s.split(' '));

const JS_KW = set(
  'const let var function return if else for while do switch case break continue new ' +
  'class extends super this typeof instanceof in of try catch finally throw async await ' +
  'yield import export from default delete void get set static public private protected ' +
  'readonly interface type enum namespace implements as satisfies keyof infer'
);
const JS_LIT = set('true false null undefined NaN Infinity');

const PY_KW = set(
  'def return if elif else for while break continue class import from as pass with try ' +
  'except finally raise lambda yield global nonlocal assert del in is not and or async ' +
  'await match case'
);
const PY_LIT = set('True False None self cls');

const SH_KW = set(
  'if then else elif fi for while until do done case esac function in return export local ' +
  'readonly declare echo cd source set unset shift exit trap eval'
);

const LANGS = {
  js: {
    rules: [
      ['com', BLOCK_COMMENT], ['com', LINE_SLASH],
      ['str', STR_T], ['str', STR_D], ['str', STR_S],
      ['num', NUMBER], ['ident', IDENT],
    ],
    kw: JS_KW, lit: JS_LIT,
  },
  python: {
    rules: [
      ['str', /(?:[rbfRBF]{0,2})"""[\s\S]*?"""/y], ['str', /(?:[rbfRBF]{0,2})'''[\s\S]*?'''/y],
      ['com', LINE_HASH],
      ['str', /(?:[rbfRBF]{0,2})"(?:\\.|[^"\\])*"/y], ['str', /(?:[rbfRBF]{0,2})'(?:\\.|[^'\\])*'/y],
      ['num', NUMBER], ['ident', IDENT],
    ],
    kw: PY_KW, lit: PY_LIT,
  },
  bash: {
    rules: [
      ['com', LINE_HASH],
      ['str', STR_D], ['str', STR_S],
      ['var', /\$\{[^}]*\}|\$[\w@*#?!-]+/y],
      ['num', NUMBER], ['ident', /[A-Za-z_][\w-]*/y],
    ],
    kw: SH_KW, lit: new Set(),
  },
  json: {
    rules: [
      ['attr', /"(?:\\.|[^"\\])*"(?=\s*:)/y],
      ['str', STR_D],
      ['num', /-?\d[\d.eE+-]*/y],
      ['ident', /[a-zA-Z]+/y],
    ],
    kw: new Set(), lit: set('true false null'),
  },
  css: {
    rules: [
      ['com', BLOCK_COMMENT],
      ['str', STR_D], ['str', STR_S],
      ['key', /@[\w-]+/y],
      ['num', /#[\da-fA-F]{3,8}\b|\d[\d.]*(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|pt)?/y],
      ['attr', /[A-Za-z-]+(?=\s*:)/y],
      ['ident', /[A-Za-z_-][\w-]*/y],
    ],
    kw: new Set(), lit: new Set(),
  },
  html: {
    rules: [
      ['com', /<!--[\s\S]*?-->/y],
      ['str', STR_D], ['str', STR_S],
      ['tag', /<\/?[A-Za-z][\w-]*|\/?>/y],
      ['attr', /[A-Za-z_:][\w:.-]*(?=\s*=)/y],
    ],
    kw: new Set(), lit: new Set(),
  },
  yaml: {
    rules: [
      ['com', LINE_HASH],
      ['attr', /[\w.-]+(?=\s*:(?:\s|$))/y],
      ['str', STR_D], ['str', STR_S],
      ['num', NUMBER], ['ident', /[A-Za-z_][\w-]*/y],
    ],
    kw: new Set(), lit: set('true false null yes no on off True False None Yes No'),
  },
  generic: {
    rules: [
      ['com', BLOCK_COMMENT], ['com', LINE_SLASH], ['com', LINE_HASH],
      ['str', STR_T], ['str', STR_D], ['str', STR_S],
      ['num', NUMBER], ['ident', IDENT],
    ],
    kw: JS_KW, lit: JS_LIT,
  },
};

// alias de langage → clé de table. Tout inconnu retombe sur `generic`.
const ALIAS = {
  javascript: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  typescript: 'js', ts: 'js', tsx: 'js',
  py: 'python', python: 'python', python3: 'python',
  sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', xml: 'html', svg: 'html', svelte: 'html', vue: 'html',
  yaml: 'yaml', yml: 'yaml',
  diff: 'diff', patch: 'diff',
};

// libellés affichés dans l'en-tête du bloc.
const LABELS = {
  js: 'JavaScript', python: 'Python', bash: 'Shell', json: 'JSON', css: 'CSS',
  html: 'HTML', yaml: 'YAML', diff: 'Diff',
};
const RAW_LABELS = {
  ts: 'TypeScript', tsx: 'TSX', typescript: 'TypeScript', jsx: 'JSX',
  svelte: 'Svelte', vue: 'Vue', scss: 'SCSS', sql: 'SQL', go: 'Go', rust: 'Rust',
  rs: 'Rust', java: 'Java', kotlin: 'Kotlin', php: 'PHP', ruby: 'Ruby', rb: 'Ruby',
  toml: 'TOML', ini: 'INI', md: 'Markdown', markdown: 'Markdown', c: 'C', cpp: 'C++',
};

export function langLabel(lang) {
  const l = (lang || '').toLowerCase();
  if (!l) return 'Text';
  return RAW_LABELS[l] || LABELS[ALIAS[l]] || l.toUpperCase();
}

// Découpe `code` en tokens. Passage UNIQUE qui alimente à la fois le rendu (`renderTokens`) et
// le repérage du symbole sous le curseur (`symbolAt`). Chaque entrée porte :
//   cls    — la classe brute du scanner ('ident', 'str', 'com', 'num', 'tag'…), ou null pour
//            les caractères qu'aucune règle ne reconnaît ;
//   klass  — la classe CSS réellement émise, qui peut être null (un identifiant ordinaire
//            n'est pas enveloppé, cf. la note de `symbolAt`).
// Les caractères non reconnus sont REGROUPÉS en un seul token : `esc` échappe caractère par
// caractère, donc grouper ne change pas d'un octet la sortie de `renderTokens`.
export function scanTokens(code, lang) {
  const cfg = LANGS[ALIAS[(lang || '').toLowerCase()] || 'generic'] || LANGS.generic;
  const { rules, kw, lit } = cfg;
  const n = code.length;
  const out = [];
  let i = 0, plain = -1; // `plain` = début du run non reconnu en cours
  const flushPlain = (end) => {
    if (plain < 0) return;
    out.push({ cls: null, klass: null, start: plain, end, text: code.slice(plain, end) });
    plain = -1;
  };
  while (i < n) {
    let matched = false;
    for (const [cls, re] of rules) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (!m || m.index !== i || !m[0].length) continue;
      const tok = m[0];
      let klass = cls;
      if (cls === 'ident') {
        if (kw.has(tok)) klass = 'key';
        else if (lit.has(tok)) klass = 'bool';
        else {
          let j = i + tok.length;
          while (j < n && (code[j] === ' ' || code[j] === '\t')) j++;
          klass = code[j] === '(' ? 'fn' : null;
        }
      }
      flushPlain(i);
      out.push({ cls, klass, start: i, end: i + tok.length, text: tok });
      i += tok.length;
      matched = true;
      break;
    }
    if (!matched) { if (plain < 0) plain = i; i++; }
  }
  flushPlain(n);
  return out;
}

function renderTokens(tokens) {
  let out = '';
  for (const t of tokens) out += t.klass ? `<span class="hl-${t.klass}">${esc(t.text)}</span>` : esc(t.text);
  return out;
}

// diff : coloration ligne à ligne (ajout / suppression / en-tête / hunk).
// Classed lines are display:block, so they already break: a '\n' after them would add an empty line.
function highlightDiff(code) {
  return code.split('\n').map((line) => {
    let cls = '';
    if (/^@@/.test(line)) cls = 'diff-hunk';
    else if (/^(\+\+\+|---|diff |index |new file|deleted file|rename )/.test(line)) cls = 'diff-meta';
    else if (line[0] === '+') cls = 'diff-add';
    else if (line[0] === '-') cls = 'diff-del';
    return cls ? `<span class="hl-${cls}">${esc(line)}</span>` : esc(line) + '\n';
  }).join('').replace(/\n$/, '');
}

// rend `code` en HTML coloré (déjà échappé). `lang` est le tag de la fence.
export function highlight(code, lang) {
  const key = ALIAS[(lang || '').toLowerCase()] || 'generic';
  if (key === 'diff') return highlightDiff(code);
  return renderTokens(scanTokens(code, lang));
}

// ── symbole sous le curseur (« go to definition ») ────────────────────────────────────────
//
// Mots-clés par langage pour le FILTRAGE des symboles cliquables. Volontairement DISSOCIÉ de
// `LANGS` : Go, Rust, Java, C#, PHP, Ruby et SQL n'ont pas de table de coloration (ils
// retombent sur `generic`, qui n'a aucun mot-clé), et `func` en Go doit malgré tout être
// rejeté. Ajouter une entrée ici ne change RIEN au rendu.
const GO_KW = set(
  'break case chan const continue default defer else fallthrough for func go goto if import ' +
  'interface map package range return select struct switch type var nil true false iota'
);
const RUST_KW = set(
  'as async await break const continue crate dyn else enum extern false fn for if impl in let ' +
  'loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'
);
const JAVA_KW = set(
  'abstract assert boolean break byte case catch char class const continue default do double ' +
  'else enum extends final finally float for goto if implements import instanceof int interface ' +
  'long native new package private protected public return short static strictfp super switch ' +
  'synchronized this throw throws transient try void volatile while var record sealed true false null'
);
const CSHARP_KW = set(
  'abstract as base bool break byte case catch char checked class const continue decimal default ' +
  'delegate do double else enum event explicit extern false finally fixed float for foreach goto ' +
  'if implicit in int interface internal is lock long namespace new null object operator out ' +
  'override params private protected public readonly ref return sbyte sealed short sizeof stackalloc ' +
  'static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using ' +
  'var virtual void volatile while async await record'
);
const PHP_KW = set(
  'abstract and array as break callable case catch class clone const continue declare default do ' +
  'echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final ' +
  'finally fn for foreach function global goto if implements include include_once instanceof ' +
  'insteadof interface isset list match namespace new or print private protected public readonly ' +
  'require require_once return static switch throw trait try unset use var while xor yield true false null'
);
const RUBY_KW = set(
  'alias and begin break case class def defined do else elsif end ensure false for if in module ' +
  'next nil not or redo rescue retry return self super then true undef unless until when while yield'
);
const SQL_KW = set(
  'select from where insert into values update set delete create table view index drop alter add ' +
  'column primary key foreign references join inner left right outer full on group by order having ' +
  'limit offset union all distinct as and or not null is in exists between like case when then else ' +
  'end begin commit rollback with returning'
);
// Svelte/Vue : mots-clés JS PLUS ceux des blocs de template — sans eux, `each` dans
// `{#each items as item}` serait proposé comme symbole.
const SVELTE_KW = set([...JS_KW, ...JS_LIT, 'each', 'then', 'catch', 'await', 'key', 'snippet', 'render', 'html', 'const', 'debug'].join(' '));

const SYMBOL_KW = {
  go: GO_KW, rust: RUST_KW, rs: RUST_KW,
  java: JAVA_KW, kotlin: JAVA_KW, kt: JAVA_KW,
  csharp: CSHARP_KW, cs: CSHARP_KW,
  php: PHP_KW, ruby: RUBY_KW, rb: RUBY_KW,
  sql: SQL_KW,
  svelte: SVELTE_KW, vue: SVELTE_KW,
};

// Mots à ne jamais proposer, quel que soit le langage : sans table de coloration ni entrée
// SYMBOL_KW, ils resteraient cliquables et ne mèneraient nulle part.
const UNIVERSAL_NOISE = set('true false null nil none undefined this self super');

const kwCache = new Map();
function symbolKeywords(lang) {
  const raw = (lang || '').toLowerCase();
  let s = kwCache.get(raw);
  if (s) return s;
  const own = SYMBOL_KW[raw];
  const cfg = LANGS[ALIAS[raw]];
  s = new Set(UNIVERSAL_NOISE);
  if (own) for (const w of own) s.add(w);
  if (cfg) { for (const w of cfg.kw) s.add(w); for (const w of cfg.lit) s.add(w); }
  kwCache.set(raw, s);
  return s;
}

const WORD_CHAR = /[A-Za-z0-9_$]/;
const WORD_HEAD = /[A-Za-z_$]/;
const MIN_LEN = 2, MAX_LEN = 128;

// Le symbole cliquable qui contient `offset`, ou null.
//
// IMPORTANT : on ne s'appuie PAS sur le fait que la table du langage produise un token
// `ident`. La table `html` — donc `.svelte` et `.vue`, le gros de ce dépôt — n'a aucune règle
// d'identifiant, et `generic` (Go, Rust, Java…) n'en produit que sans classe. Un `symbolAt`
// piloté par les tokens ne trouverait donc jamais rien dans un fichier Svelte.
// On délimite le mot nous-mêmes, et les tokens ne servent qu'à EXCLURE : chaînes et
// commentaires, que toutes les tables savent reconnaître.
export function symbolAt(code, lang, offset) {
  if (typeof code !== 'string' || !code || !Number.isFinite(offset)) return null;
  const n = code.length;
  let i = Math.max(0, Math.min(offset, n - 1));
  if (!WORD_CHAR.test(code[i])) {
    // le curseur est posé JUSTE APRÈS un mot (fin de ligne, clic au bord) → on recule d'un cran
    if (i === 0 || !WORD_CHAR.test(code[i - 1])) return null;
    i -= 1;
  }
  let start = i;
  while (start > 0 && WORD_CHAR.test(code[start - 1])) start--;
  let end = i + 1;
  while (end < n && WORD_CHAR.test(code[end])) end++;
  if (!WORD_HEAD.test(code[start])) return null;   // 42, 0xFF… : pas un identifiant

  const word = code.slice(start, end);
  if (word.length < MIN_LEN || word.length > MAX_LEN) return null;
  if (symbolKeywords(lang).has(word)) return null;

  // dans une chaîne ou un commentaire → ce n'est pas un symbole du programme
  for (const t of scanTokens(code, lang)) {
    if (t.end <= start) continue;
    if (t.start >= end) break;
    if (t.cls === 'str' || t.cls === 'com') return null;
  }

  let j = end;
  while (j < n && (code[j] === ' ' || code[j] === '\t')) j++;
  return { word, start, end, kind: code[j] === '(' ? 'call' : 'ident' };
}
