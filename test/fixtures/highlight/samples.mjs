/*
 * Corpus de caractérisation du highlighter (src/lib/highlight.js).
 *
 * Ces échantillons ne sont PAS choisis pour être jolis : chacun couvre une règle ou une
 * interaction de règles que le moteur peut casser silencieusement lors d'un refactor
 * (chaînes contenant un délimiteur, commentaire en fin de ligne, identifiant suivi d'une
 * parenthèse, échappement HTML, langage inconnu). La sortie exacte est figée dans
 * baseline.json ; cf. test/highlightBaseline.test.mjs.
 */
export const SAMPLES = [
  { name: 'js/keywords-and-calls', lang: 'js', code:
    'export async function refineWithAgent(state, alive) {\n' +
    '  const n = compute(state) ?? 0;\n' +
    '  return n > 0 ? new Map([[1, true]]) : null;\n' +
    '}' },
  { name: 'js/strings-and-comments', lang: 'js', code:
    "// a line comment with 'quotes' and a call() inside\n" +
    '/* block\n   comment */\n' +
    'const s = "he said \\"hi\\"", t = \'a // b\', u = `tpl ${x + 1} end`;' },
  { name: 'js/html-escaping', lang: 'js', code:
    'const cmp = a < b && c > d;\nconst frag = "<div class=\\"x\\">&amp;</div>";' },
  { name: 'js/numbers', lang: 'js', code:
    'const a = 0xFF, b = 1_000, c = 3.14, d = .5, e = 1e-9;' },
  { name: 'ts/aliased-to-js', lang: 'ts', code:
    'interface Foo { bar: string }\ntype Baz = keyof Foo;\nclass Impl implements Foo { bar = "x"; }' },
  { name: 'python/def-and-strings', lang: 'python', code:
    'def refine(state, *, alive=True):\n' +
    '    """doc with \'quotes\'"""\n' +
    '    # a comment\n' +
    '    return None if not alive else self.compute(state)' },
  { name: 'bash/vars-and-flags', lang: 'bash', code:
    '#!/usr/bin/env bash\n' +
    'set -euo pipefail\n' +
    'for f in "${FILES[@]}"; do echo "$f" | grep -q foo-bar && exit 1; done' },
  { name: 'json/object', lang: 'json', code:
    '{ "name": "hooked", "version": 2, "private": true, "deps": null }' },
  { name: 'css/rules', lang: 'css', code:
    '/* c */\n@media (min-width: 760px) {\n  .dv-code { color: #c9cedb; padding: 0 10px; }\n}' },
  { name: 'html/tags', lang: 'html', code:
    '<!-- c -->\n<div class="dv" data-line="12">\n  <code>a &lt; b</code>\n</div>' },
  { name: 'svelte/aliased-to-html', lang: 'svelte', code:
    '<script>\n  let { name = "x" } = $props();\n  function greet() { return name; }\n</script>\n<h1>{greet()}</h1>' },
  { name: 'yaml/mapping', lang: 'yaml', code:
    '# c\nname: hooked\non:\n  push:\n    branches: [main]\nvalue: "quoted"' },
  { name: 'diff/patch', lang: 'diff', code:
    'diff --git a/x.js b/x.js\nindex 1..2 100644\n--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n unchanged' },
  { name: 'go/unknown-falls-back-to-generic', lang: 'go', code:
    'func Refine(s *State) error {\n\t// comment\n\treturn fmt.Errorf("bad: %w", err)\n}' },
  { name: 'rust/unknown-falls-back-to-generic', lang: 'rust', code:
    'pub fn refine(s: &State) -> Result<(), Error> {\n    let n = s.count();\n    Ok(())\n}' },
  { name: 'unknown/no-lang', lang: '', code: 'anything at all <b>&</b> 42 // x' },
  { name: 'edge/empty', lang: 'js', code: '' },
  { name: 'edge/unterminated-string', lang: 'js', code: 'const s = "never closed\nconst t = 1;' },
];
