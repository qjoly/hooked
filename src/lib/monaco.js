/*
 * Chargeur Monaco paresseux & partagé. Monaco est browser-only (touche `self`, `document`) →
 * ce module n'est importé QUE dynamiquement, depuis onMount (jamais évalué en SSR).
 *
 * Workers : imports STATIQUES `?worker`. C'est le pattern Vite fiable — le plugin worker les
 * transforme à la compilation en constructeurs `new Worker(new URL(chunk))`, HORS dep-optimizer.
 * L'import DYNAMIQUE des workers (ancienne version) cassait par intermittence en dev :
 * « Failed to fetch dynamically imported module …json.worker » quand Vite ré-optimisait les deps
 * (le hash `?v=` changeait → URL périmée). Les imports statiques n'ont pas ce souci.
 *
 * NB: le champ `exports` de monaco-editor 0.56 mappe `./*` → `./esm/vs/*.js`, donc on importe
 * SANS le préfixe `esm/vs/` (sinon double préfixe → résolution cassée). Les workers de langage
 * (chemins multi-segments) sont aliasés vers leurs vrais fichiers dans vite.config.js.
 */
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

// Ce module n'étant importé qu'en browser, `self` existe ; on garde le garde par prudence.
if (typeof self !== 'undefined') {
  self.MonacoEnvironment = {
    getWorker(_id, label) {
      if (label === 'json') return new JsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
      if (label === 'typescript' || label === 'javascript') return new TsWorker();
      return new EditorWorker();
    },
  };
}

let _p = null;
export function getMonaco() {
  return (_p ||= import('monaco-editor'));
}

// Nom de fichier → identifiant de langage Monaco (best-effort, défaut plaintext).
export function langFromName(name = '') {
  const base = name.split('/').pop().toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  const map = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    json: 'json', jsonc: 'json', json5: 'json',
    css: 'css', scss: 'scss', less: 'less',
    html: 'html', htm: 'html', svelte: 'html', vue: 'html',
    md: 'markdown', markdown: 'markdown', mdx: 'markdown',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
    php: 'php', swift: 'swift', scala: 'scala', lua: 'lua', r: 'r', dart: 'dart',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
    sql: 'sql', xml: 'xml', svg: 'xml', graphql: 'graphql', gql: 'graphql', proto: 'proto',
  };
  return map[ext] || 'plaintext';
}
