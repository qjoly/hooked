/*
 * symbolAt (src/lib/highlight.js) : le symbole cliquable sous le curseur, brique d'entrée du
 * « go to definition » (docs/specs/go-to-definition.md).
 *
 * Ce qui est vérifié ici, c'est surtout ce qui NE doit PAS être proposé : un mot-clé, un
 * littéral, l'intérieur d'une chaîne ou d'un commentaire, un nombre. Un faux positif n'est pas
 * une erreur cosmétique — il envoie une requête serveur qui ne peut rien trouver, et souligne
 * un mot en promettant une définition qui n'existe pas.
 */
import { describe, it, expect } from 'vitest';
import { symbolAt, scanTokens } from '../src/lib/highlight.js';

const at = (code, lang, needle, occurrence = 0) => {
  let i = -1;
  for (let k = 0; k <= occurrence; k++) i = code.indexOf(needle, i + 1);
  if (i < 0) throw new Error(`needle ${needle} introuvable`);
  return symbolAt(code, lang, i + 1); // curseur À L'INTÉRIEUR du mot
};

describe('symbolAt — ce qui est un symbole', () => {
  it('reconnaît un appel de fonction et le marque `call`', () => {
    expect(at('const n = refineWithAgent(state);', 'js', 'refineWithAgent'))
      .toEqual({ word: 'refineWithAgent', start: 10, end: 25, kind: 'call' });
  });
  it('reconnaît un nom de TYPE, que le highlighter n\'enveloppe dans aucun span', () => {
    const code = 'let x: FooBar = null;';
    // le highlighter n'émet aucun élément pour ce token → le hit-test ne peut pas s'y fier
    expect(scanTokens(code, 'ts').find((t) => t.text === 'FooBar').klass).toBe(null);
    expect(at(code, 'ts', 'FooBar')).toMatchObject({ word: 'FooBar', kind: 'ident' });
  });
  it('reconnaît une propriété après un point', () => {
    expect(at('obj.someMethod()', 'js', 'someMethod')).toMatchObject({ word: 'someMethod', kind: 'call' });
  });
  it('accepte un identifiant à $ (RxJS, Svelte)', () => {
    expect(at('const data$ = of(1);', 'js', 'data$')).toMatchObject({ word: 'data$' });
  });

  // La table `html` — donc .svelte et .vue, l'essentiel de ce dépôt — n'a AUCUNE règle
  // d'identifiant : un symbolAt piloté par les tokens n'y trouverait jamais rien.
  it('fonctionne dans un fichier Svelte malgré une table sans règle `ident`', () => {
    const code = 'function greet() { return name; }';
    expect(scanTokens(code, 'svelte').every((t) => t.cls !== 'ident')).toBe(true);
    expect(at(code, 'svelte', 'greet')).toMatchObject({ word: 'greet', kind: 'call' });
  });
  it('fonctionne en Go, qui n\'a pas de table de coloration', () => {
    expect(at('func Refine(s *State) error {', 'go', 'Refine')).toMatchObject({ word: 'Refine' });
  });
});

describe('symbolAt — ce qui n\'en est pas', () => {
  it('rejette un mot-clé JS', () => {
    expect(at('const a = 1;', 'js', 'const')).toBe(null);
    expect(at('return foo;', 'js', 'return')).toBe(null);
  });
  it('rejette un mot-clé des langages SANS table de coloration', () => {
    expect(at('func Refine() {}', 'go', 'func')).toBe(null);
    expect(at('pub fn refine() {}', 'rust', 'fn')).toBe(null);
    expect(at('public class Foo {}', 'java', 'class')).toBe(null);
    expect(at('def refine(self):', 'ruby', 'def')).toBe(null);
  });
  it('rejette les mots-clés de TEMPLATE Svelte', () => {
    expect(at('{#each items as item}', 'svelte', 'each')).toBe(null);
  });
  it('rejette un littéral, dans tous les langages', () => {
    expect(at('const a = true;', 'js', 'true')).toBe(null);
    expect(at('x = None', 'python', 'None')).toBe(null);
    expect(at('return nil', 'go', 'nil')).toBe(null);
  });
  it('rejette l\'intérieur d\'une chaîne', () => {
    expect(at('const s = "refineWithAgent";', 'js', 'refineWithAgent')).toBe(null);
    expect(at("const s = 'refineWithAgent';", 'js', 'refineWithAgent')).toBe(null);
    expect(at('const s = `x ${1} refineWithAgent`;', 'js', 'refineWithAgent')).toBe(null);
  });
  it('rejette l\'intérieur d\'un commentaire, ligne ET bloc', () => {
    expect(at('// call refineWithAgent here', 'js', 'refineWithAgent')).toBe(null);
    expect(at('/* see refineWithAgent */', 'js', 'refineWithAgent')).toBe(null);
    expect(at('# call refine here', 'python', 'refine')).toBe(null);
  });
  it('accepte le MÊME mot hors de la chaîne, sur la même ligne', () => {
    const code = 'const s = "refine"; refine(s);';
    expect(at(code, 'js', 'refine', 0)).toBe(null);          // dans la chaîne
    expect(at(code, 'js', 'refine', 1)).toMatchObject({ kind: 'call' }); // l'appel
  });
  it('rejette un nombre, même hexadécimal', () => {
    expect(symbolAt('const a = 0xFF;', 'js', 11)).toBe(null);
    expect(symbolAt('const a = 42;', 'js', 11)).toBe(null);
  });
  it('rejette un mot d\'une seule lettre (i, x, _) — bruit garanti', () => {
    expect(at('for (let i = 0; i < n; i++)', 'js', 'i')).toBe(null);
  });
});

describe('symbolAt — bords', () => {
  it('renvoie null hors de tout mot', () => {
    expect(symbolAt('a  =  b', 'js', 2)).toBe(null);
  });
  it('accroche le mot quand le curseur est posé juste après lui', () => {
    expect(symbolAt('refineAll', 'js', 9)).toMatchObject({ word: 'refineAll' });
  });
  it('accroche le mot quand le curseur est sur son premier caractère', () => {
    expect(symbolAt('refineAll()', 'js', 0)).toMatchObject({ word: 'refineAll' });
  });
  it('encaisse les entrées absurdes sans lever', () => {
    expect(symbolAt('', 'js', 0)).toBe(null);
    expect(symbolAt(null, 'js', 0)).toBe(null);
    expect(symbolAt('abc', 'js', -5)).toMatchObject({ word: 'abc' });
    expect(symbolAt('abc', 'js', 999)).toMatchObject({ word: 'abc' });
    expect(symbolAt('abc', 'js', NaN)).toBe(null);
  });
  it('rejette un identifiant absurdement long', () => {
    const long = 'a'.repeat(200);
    expect(symbolAt(long, 'js', 5)).toBe(null);
  });
  it('donne des offsets qui découpent exactement le mot dans la source', () => {
    const code = '  const out = buildVcsChanges(cwd);';
    const r = at(code, 'js', 'buildVcsChanges');
    expect(code.slice(r.start, r.end)).toBe(r.word);
  });
});
