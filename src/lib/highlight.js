// Coloration syntaxique légère et sans dépendance.
//
// Un seul moteur (tokenize) piloté par des tables de règles par langage. Chaque
// règle = [classe, regex collante (flag `y`)]. À chaque position on essaie les
// règles dans l'ordre ; la première qui matche au curseur gagne. Tout ce qui
// n'est reconnu par aucune règle est échappé caractère par caractère.
//
// Les classes produites (`hl-com`, `hl-str`, …) sont stylées dans app.css.

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
  if (!l) return 'Texte';
  return RAW_LABELS[l] || LABELS[ALIAS[l]] || l.toUpperCase();
}

function tokenize(code, rules, kw, lit) {
  const n = code.length;
  let out = '', i = 0;
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
      out += klass ? `<span class="hl-${klass}">${esc(tok)}</span>` : esc(tok);
      i += tok.length;
      matched = true;
      break;
    }
    if (!matched) { out += esc(code[i]); i++; }
  }
  return out;
}

// diff : coloration ligne à ligne (ajout / suppression / en-tête / hunk).
function highlightDiff(code) {
  return code.split('\n').map((line) => {
    let cls = '';
    if (/^@@/.test(line)) cls = 'diff-hunk';
    else if (/^(\+\+\+|---|diff |index |new file|deleted file|rename )/.test(line)) cls = 'diff-meta';
    else if (line[0] === '+') cls = 'diff-add';
    else if (line[0] === '-') cls = 'diff-del';
    return cls ? `<span class="hl-${cls}">${esc(line)}</span>` : esc(line);
  }).join('\n');
}

// rend `code` en HTML coloré (déjà échappé). `lang` est le tag de la fence.
export function highlight(code, lang) {
  const key = ALIAS[(lang || '').toLowerCase()] || 'generic';
  if (key === 'diff') return highlightDiff(code);
  const cfg = LANGS[key] || LANGS.generic;
  return tokenize(code, cfg.rules, cfg.kw, cfg.lit);
}
