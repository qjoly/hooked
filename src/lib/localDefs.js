// Reconnaissance d'une DÉCLARATION dans une ligne de code, par motifs.
//
// Brique partagée entre le front et le back du « go to definition » :
//   • le front l'applique au fichier affiché — une définition dans le fichier qu'on lit se
//     résout sans le moindre aller-retour serveur (et c'est le cas le plus fréquent) ;
//   • le back l'applique aux lignes que `git grep` renvoie, pour séparer les déclarations
//     des simples références.
// Les deux DOIVENT partager la table, sinon le soulignement du front promettrait une
// définition que le back ne retrouverait pas.
//
// C'est de l'heuristique par regex, pas de l'analyse syntaxique : on distingue
// `function refine(` d'un appel `refine(state)`, on ne résout ni les alias d'import, ni les
// surcharges, ni les génériques. La ligne, et rien d'autre.
//
// server/symbols.js l'importe en RELATIF (`../src/lib/localDefs.js`) : `$lib` est un alias
// Vite, absent sous Vitest comme sous Node nu. Précédent : server/editor.js.

// Le symbole est validé en amont (`[A-Za-z_$][\w$]*`) mais `$` reste un métacaractère.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Modificateurs tolérés entre le début de ligne et le mot-clé de déclaration.
const MODS = {
  js: '(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:static\\s+)?(?:readonly\\s+)?(?:async\\s+)?',
  python: '(?:async\\s+)?',
  go: '',
  rust: '(?:pub(?:\\([^)]*\\))?\\s+)?(?:default\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?',
  java: '(?:(?:public|private|protected|static|final|abstract|sealed|synchronized|native|default)\\s+)*',
  csharp: '(?:(?:public|private|protected|internal|static|abstract|sealed|override|virtual|async|partial|readonly|new)\\s+)*',
  ruby: '',
  php: '(?:(?:public|private|protected|static|abstract|final|readonly)\\s+)*',
};

// [motif après les modificateurs, `kind`]. `S` est remplacé par le symbole échappé.
const RULES = {
  js: [
    ['function\\s*\\*?\\s*S\\b', 'function'],
    ['class\\s+S\\b', 'class'],
    ['(?:type|interface|enum)\\s+S\\b', 'type'],
    ['(?:const|let|var)\\s+S\\b\\s*=\\s*(?:async\\s*)?(?:function\\b|\\()', 'function'],
    ['(?:const|let|var)\\s+S\\b', 'const'],
    ['S\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>)', 'function'],
    ['(?:get|set)\\s+S\\s*\\(', 'method'],
    ['S\\s*\\([^)]*\\)\\s*\\{', 'method'],
  ],
  python: [
    ['def\\s+S\\b', 'function'],
    ['class\\s+S\\b', 'class'],
  ],
  go: [
    ['func\\s+S\\b', 'function'],
    ['func\\s*\\([^)]*\\)\\s*S\\b', 'method'],
    ['type\\s+S\\b', 'type'],
    ['(?:var|const)\\s+S\\b', 'const'],
  ],
  rust: [
    ['fn\\s+S\\b', 'function'],
    ['(?:struct|enum|union)\\s+S\\b', 'type'],
    ['trait\\s+S\\b', 'type'],
    ['type\\s+S\\b', 'type'],
    ['(?:static|const)\\s+S\\b', 'const'],
    ['macro_rules!\\s*S\\b', 'macro'],
  ],
  java: [
    ['(?:class|interface|enum|record)\\s+S\\b', 'class'],
    ['[\\w<>\\[\\],.?\\s]+\\s+S\\s*\\(', 'method'],
  ],
  csharp: [
    ['(?:class|interface|enum|record|struct)\\s+S\\b', 'class'],
    ['[\\w<>\\[\\],.?\\s]+\\s+S\\s*\\(', 'method'],
  ],
  ruby: [
    ['def\\s+(?:self\\.)?S\\b', 'function'],
    ['(?:class|module)\\s+S\\b', 'class'],
  ],
  php: [
    ['function\\s+S\\s*\\(', 'function'],
    ['(?:class|trait|interface|enum)\\s+S\\b', 'class'],
  ],
};

// Extension → clé de RULES. Distinct de `langFromName` (difflines.js), qui vise la
// COLORATION : ici .svelte/.vue relèvent des motifs JS, pas de ceux du HTML.
const EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  svelte: 'js', vue: 'js',
  py: 'python', pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java', kt: 'java', kts: 'java', scala: 'java',
  cs: 'csharp',
  rb: 'ruby', rake: 'ruby',
  php: 'php',
};

// Clé de motifs pour un chemin. null = langage sans table : aucune déclaration ne sera
// reconnue, et la réponse ne contiendra que des références. C'est délibéré — mieux vaut
// « je n'ai trouvé que des occurrences » qu'une fausse définition.
export function langOfPath(p) {
  const base = String(p || '').split('/').pop().toLowerCase();
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return EXT[ext] || null;
}

const cache = new Map(); // `${lang}\0${symbol}` -> [{ re, kind }]
function rulesFor(lang, symbol) {
  const key = lang + '\0' + symbol;
  let v = cache.get(key);
  if (v) return v;
  const rules = RULES[lang];
  if (!rules) { cache.set(key, []); return []; }
  const S = escapeRe(symbol);
  const mods = MODS[lang] ?? '';
  // `S\b` dans un motif devient `<symbole>(?![\w$])`, JAMAIS `<symbole>\b` : `\b` exige un
  // caractère de mot d'un côté, donc il ÉCHOUE sur un identifiant terminé par `$` — `data$ =`
  // ne matcherait pas. Même piège que le `-F` manquant de git grep, une couche plus haut.
  // Une seule passe de remplacement : en deux, un symbole contenant `S` (`State`…) verrait la
  // seconde passe réécrire l'intérieur de ce que la première vient d'insérer.
  v = rules.map(([body, kind]) => ({
    re: new RegExp('^\\s*' + mods + body.replace(/S\\b|S/g, (m) => (m.length > 1 ? S + '(?![\\w$])' : S))),
    kind,
  }));
  if (cache.size > 500) cache.clear(); // borne : une session de review touche peu de symboles
  cache.set(key, v);
  return v;
}

// `lineText` déclare-t-elle `symbol` ? → le `kind` ('function', 'class', 'type'…) ou null.
export function declarationKind(lineText, lang, symbol) {
  if (!lineText || !lang || !symbol) return null;
  for (const { re, kind } of rulesFor(lang, symbol)) if (re.test(lineText)) return kind;
  return null;
}

// Première déclaration de `symbol` dans `fileText` → { line (1-based), kind }, ou null.
// Utilisé côté front sur le fichier affiché : zéro requête, réponse dans la frame.
export function localDeclaration(fileText, lang, symbol) {
  if (typeof fileText !== 'string' || !fileText || !lang || !symbol) return null;
  if (!fileText.includes(symbol)) return null; // écarte 99 % des fichiers sans découper les lignes
  const lines = fileText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kind = declarationKind(lines[i], lang, symbol);
    if (kind) return { line: i + 1, kind };
  }
  return null;
}
