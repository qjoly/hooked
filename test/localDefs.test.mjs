/*
 * localDefs (src/lib/localDefs.js) : « cette ligne déclare-t-elle ce symbole ? »
 *
 * C'est le partage-clé du « go to definition » : le front l'applique au fichier affiché
 * (résolution sans requête) et le back aux lignes rendues par `git grep` (déclarations vs
 * références). Les deux doivent voir la même chose, sinon le front souligne une définition
 * que le back ne retrouve pas.
 *
 * Ce qui se casse en silence ici, c'est la frontière du symbole : `refine` ne doit pas
 * matcher `refineAll`, et `data$` doit matcher malgré le `$`.
 */
import { describe, it, expect } from 'vitest';
import { declarationKind, localDeclaration, langOfPath } from '../src/lib/localDefs.js';

const js = (line, sym) => declarationKind(line, 'js', sym);

describe('declarationKind — JS/TS', () => {
  it('reconnaît les formes de déclaration et leur nature', () => {
    expect(js('function refine(s) {', 'refine')).toBe('function');
    expect(js('export async function refine(s) {', 'refine')).toBe('function');
    expect(js('export default function refine() {', 'refine')).toBe('function');
    expect(js('function* refine() {', 'refine')).toBe('function');
    expect(js('export class Store {', 'Store')).toBe('class');
    expect(js('interface FileContents {', 'FileContents')).toBe('type');
    expect(js('export type Themes = string;', 'Themes')).toBe('type');
    expect(js('const build = (a, b) => {', 'build')).toBe('function');
    expect(js('const build = async function () {', 'build')).toBe('function');
    expect(js('  const CTX = 3;', 'CTX')).toBe('const');
    expect(js('  loadFull(file) {', 'loadFull')).toBe('method');
    expect(js('  get ratio() {', 'ratio')).toBe('method');
  });

  it('ne prend pas une utilisation pour une déclaration', () => {
    expect(js('  const x = refine(state);', 'refine')).toBe(null);
    expect(js('  this.refine(state);', 'refine')).toBe(null);
    expect(js('  return refine;', 'refine')).toBe(null);
    expect(js('import { refine } from "./x.js";', 'refine')).toBe(null);
  });

  // Le bug qui a déjà mordu deux fois dans cette feature, à deux couches différentes.
  it('respecte la frontière du symbole, y compris pour un identifiant en $', () => {
    expect(js('const refineAll = 1;', 'refine')).toBe(null);
    expect(js('function refineAll() {', 'refine')).toBe(null);
    expect(js('const data$ = of(1);', 'data$')).toBe('const');
    expect(js('function destroy$() {', 'destroy$')).toBe('function');
  });

  it('ne se laisse pas abîmer par un symbole contenant la lettre du gabarit', () => {
    // le remplacement du placeholder `S` doit se faire en UNE passe
    expect(js('export class State {', 'State')).toBe('class');
    expect(js('function SSS() {', 'SSS')).toBe('function');
  });

  it('échappe les métacaractères du symbole', () => {
    expect(js('const a_b = 1;', 'a.b')).toBe(null);   // le `.` ne doit pas jouer les jokers
  });
});

describe('declarationKind — les autres langages', () => {
  it('python', () => {
    expect(declarationKind('def refine(self):', 'python', 'refine')).toBe('function');
    expect(declarationKind('class Store:', 'python', 'Store')).toBe('class');
    expect(declarationKind('    return refine(x)', 'python', 'refine')).toBe(null);
  });
  it('go, fonction et méthode à récepteur', () => {
    expect(declarationKind('func Refine(x int) error {', 'go', 'Refine')).toBe('function');
    expect(declarationKind('func (s *Store) Refine() {', 'go', 'Refine')).toBe('method');
    expect(declarationKind('type Store struct {', 'go', 'Store')).toBe('type');
  });
  it('rust', () => {
    expect(declarationKind('pub async fn refine(s: &S) {', 'rust', 'refine')).toBe('function');
    expect(declarationKind('pub(crate) struct Store {', 'rust', 'Store')).toBe('type');
    expect(declarationKind('trait Refine {', 'rust', 'Refine')).toBe('type');
  });
  it('java / c#', () => {
    expect(declarationKind('public final class Store {', 'java', 'Store')).toBe('class');
    expect(declarationKind('  private static String refine(int a) {', 'java', 'refine')).toBe('method');
    expect(declarationKind('public sealed record Store(int A);', 'csharp', 'Store')).toBe('class');
  });
  it('ruby et php', () => {
    expect(declarationKind('def self.refine(x)', 'ruby', 'refine')).toBe('function');
    expect(declarationKind('module Store', 'ruby', 'Store')).toBe('class');
    expect(declarationKind('public function refine($x) {', 'php', 'refine')).toBe('function');
  });
  it('un langage sans table ne déclare jamais rien', () => {
    expect(declarationKind('SET foo = 1', 'sql', 'foo')).toBe(null);
    expect(declarationKind('function refine() {', null, 'refine')).toBe(null);
  });
});

describe('langOfPath', () => {
  it('rattache .svelte et .vue aux motifs JS, pas à ceux du HTML', () => {
    // distinct de langFromName (difflines.js), qui vise la COLORATION et renvoie 'html'
    expect(langOfPath('src/lib/components/Ship.svelte')).toBe('js');
    expect(langOfPath('a/b.vue')).toBe('js');
    expect(langOfPath('a/b.tsx')).toBe('js');
  });
  it('renvoie null pour ce qu\'on ne sait pas analyser', () => {
    expect(langOfPath('a/b.txt')).toBe(null);
    expect(langOfPath('Makefile')).toBe(null);
    expect(langOfPath('')).toBe(null);
  });
});

describe('localDeclaration', () => {
  const file = [
    'import { helper } from "./h.js";',   // 1
    '',                                   // 2
    '// refine is defined below',         // 3
    'export function refine(state) {',    // 4
    '  return helper(state);',            // 5
    '}',                                  // 6
  ].join('\n');

  it('rend la ligne 1-based et la nature de la déclaration', () => {
    expect(localDeclaration(file, 'js', 'refine')).toEqual({ line: 4, kind: 'function' });
  });
  it('rend null quand le symbole n\'est qu\'utilisé', () => {
    expect(localDeclaration(file, 'js', 'helper')).toBe(null);
  });
  it('rend null quand le symbole est absent', () => {
    expect(localDeclaration(file, 'js', 'nowhere')).toBe(null);
  });
  it('encaisse les entrées vides', () => {
    expect(localDeclaration('', 'js', 'x')).toBe(null);
    expect(localDeclaration(null, 'js', 'x')).toBe(null);
    expect(localDeclaration(file, 'js', '')).toBe(null);
  });
});
