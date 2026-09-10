/*
 * server/symbols.js : résolution heuristique d'un symbole vers sa déclaration probable
 * (le back du « go to definition »).
 *
 * Trois couches, testées séparément :
 *   • parseGrep   — le format de `git grep -z` EST le contrat ; fixtures VERBATIM produites
 *                   par un vrai git (test/fixtures/symbols/*.bin), pour les deux modes ;
 *   • partition   — la partie qui décide, pure et sans I/O ;
 *   • lookup      — bout en bout sur un dépôt git jetable.
 *
 * `realpathSync(os.tmpdir())` : sous macOS /var est un lien symbolique vers /private/var
 * alors que `git rev-parse --show-toplevel` renvoie le chemin résolu — garder les deux mondes
 * alignés (même raison que test/vcsDiff.test.mjs).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIT_ID = ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...args) => execFileP('git', [...GIT_ID, ...args], { cwd });
const fx = (n) => fs.readFileSync(path.join(HERE, 'fixtures/symbols', n));

let T;
let parseGrep, partition, parseImports, lookup, readSlice;

beforeAll(async () => {
  const raw = path.join(os.tmpdir(), 'hooked-symbols-test-' + process.pid);
  fs.rmSync(raw, { recursive: true, force: true });
  fs.mkdirSync(raw, { recursive: true });
  T = fs.realpathSync(raw);
  ({ parseGrep, partition, parseImports, lookup, readSlice } = await import('../server/symbols.js'));
});
afterAll(() => { fs.rmSync(T, { recursive: true, force: true }); });

describe('parseGrep — le format de git grep -z est le contrat', () => {
  it('lit `path \\0 line \\0 content` de l\'arbre de travail', () => {
    expect(parseGrep(fx('grep-worktree.bin'), '')).toEqual([
      { rel: 'a.js', line: 1, text: 'const Foo = 1;' },
      { rel: 'a.js', line: 2, text: 'const x = Foo + 2;' },
      { rel: 'src/od d/we:ird.js', line: 1, text: 'export const Foo = 3;' },
    ]);
  });

  // Le chemin de la fixture contient une ESPACE et un DEUX-POINTS : un parseur qui découperait
  // sur `:` (ou sur les espaces) le casserait, et c'est exactement ce que fait un parseur écrit
  // pour `git grep -n` sans `-z`.
  it('survit à un chemin contenant une espace et un deux-points', () => {
    const hits = parseGrep(fx('grep-worktree.bin'), '');
    expect(hits[2].rel).toBe('src/od d/we:ird.js');
  });

  it('retire le préfixe `<rev>:` que git ajoute quand on interroge une révision', () => {
    const hits = parseGrep(fx('grep-rev.bin'), 'HEAD');
    expect(hits.map((h) => h.rel)).toEqual(['a.js', 'a.js', 'src/od d/we:ird.js']);
    expect(hits[0].text).toBe('const Foo = 1;');
  });

  it('ne retire rien si on ne lui annonce pas la révision', () => {
    expect(parseGrep(fx('grep-rev.bin'), '')[0].rel).toBe('HEAD:a.js');
  });

  it('encaisse une sortie vide ou tronquée en plein enregistrement', () => {
    expect(parseGrep(Buffer.alloc(0), '')).toEqual([]);
    expect(parseGrep(Buffer.from('a.js\0'), '')).toEqual([]);
    expect(parseGrep(Buffer.from('a.js\x0012\0no trailing newline'), '')).toEqual([
      { rel: 'a.js', line: 12, text: 'no trailing newline' },
    ]);
  });
});

describe('partition — déclarations vs références', () => {
  const c = (rel, line, text) => ({ rel, line, text });

  it('sépare la déclaration de ses appels', () => {
    const r = partition('refine', [
      c('src/a.js', 3, '  const x = refine(state);'),
      c('src/core.js', 10, 'export function refine(state) {'),
    ], {});
    expect(r.declarations.map((d) => d.rel)).toEqual(['src/core.js']);
    expect(r.references.map((d) => d.rel)).toEqual(['src/a.js']);
  });

  it('classe d\'abord un fichier importé par le fichier cliqué', () => {
    const r = partition('refine', [
      c('src/other.js', 1, 'export function refine() {'),
      c('src/core.js', 1, 'export function refine() {'),
    ], { clickRel: 'src/app.js', importedBases: ['src/core'] });
    expect(r.declarations[0].rel).toBe('src/core.js');
    expect(r.declarations[0].reason).toContain('imported by this file');
  });

  it('rétrograde une déclaration de fichier de test — mais pas si le clic vient d\'un test', () => {
    const cands = [
      c('test/a.test.mjs', 5, 'let refine;'),
      c('src/core.js', 10, 'export function refine() {'),
    ];
    const out = partition('refine', cands, { clickRel: 'src/app.js' });
    expect(out.declarations[0].rel).toBe('src/core.js');
    expect(out.declarations[1].demoted).toBe(true);

    const inTest = partition('refine', cands, { clickRel: 'test/a.test.mjs', isTestClick: true });
    expect(inTest.declarations.find((d) => d.rel === 'test/a.test.mjs').demoted).toBe(false);
  });

  it('rétrograde le généré et le vendu', () => {
    const r = partition('refine', [c('dist/bundle.js', 1, 'function refine() {')], {});
    expect(r.declarations[0].demoted).toBe(true);
    expect(r.declarations[0].reason).toContain('generated');
  });

  // Les numéros affichés dans un diff d'op `edit` sont relatifs au FRAGMENT, pas au fichier :
  // l'exclusion du site du clic doit donc se faire par texte.
  it('exclut le site du clic par TEXTE, pas par numéro de ligne', () => {
    const r = partition('refine', [
      c('src/app.js', 999, '  refine(state);'),
      c('src/core.js', 1, 'function refine() {'),
    ], { clickRel: 'src/app.js', clickLineText: '  refine(state);' });
    expect(r.references).toEqual([]);
    expect(r.declarations).toHaveLength(1);
  });

  it('est déterministe : chemin le plus court puis plus petite ligne', () => {
    const r = partition('refine', [
      c('src/deep/nested/x.js', 2, 'function refine() {'),
      c('src/a.js', 9, 'function refine() {'),
      c('src/a.js', 4, 'function refine() {'),
    ], {});
    expect(r.declarations.map((d) => d.rel + ':' + d.line)).toEqual(['src/a.js:4', 'src/a.js:9', 'src/deep/nested/x.js:2']);
  });
});

describe('parseImports', () => {
  it('relie chaque nom local à son specifier', () => {
    const { bySymbol, specifiers } = parseImports([
      "import { query, type Options } from '@anthropic-ai/claude-agent-sdk';",
      "import fs from 'node:fs';",
      "import { a as b } from './local.js';",
      "import * as ns from './ns.js';",
    ].join('\n'));
    expect(bySymbol.get('query')).toBe('@anthropic-ai/claude-agent-sdk');
    expect(bySymbol.get('fs')).toBe('node:fs');
    expect(bySymbol.get('b')).toBe('./local.js');   // le nom LOCAL, pas l'exporté
    expect(bySymbol.get('ns')).toBe('./ns.js');
    expect(specifiers).toContain('./local.js');
  });
  it('encaisse un fichier sans import', () => {
    expect(parseImports('const a = 1;').bySymbol.size).toBe(0);
    expect(parseImports(null).specifiers).toEqual([]);
  });
});

describe('lookup — bout en bout sur un dépôt git', () => {
  let repo;
  beforeAll(async () => {
    repo = path.join(T, 'proj');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'pkg/sub/node_modules'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src/core.js'), 'export function refine(s) {\n  return s;\n}\nexport const data$ = 1;\n');
    fs.writeFileSync(path.join(repo, 'src/app.js'), "import { refine } from './core.js';\nimport { outside } from 'some-pkg';\n\nrefine(1);\noutside(2);\nconst v = data$;\n");
    fs.writeFileSync(path.join(repo, 'pkg/sub/node_modules/dep.js'), 'export function refine() {}\n');
    await git(repo, 'init', '-q');
    await git(repo, 'add', 'src');
    await git(repo, 'commit', '-q', '-m', 'init');
  });

  it('trouve la déclaration plutôt que l\'appel, et ouvre directement', async () => {
    const r = await lookup(repo, { symbol: 'refine', file: path.join(repo, 'src/app.js') });
    expect(r.supported).toBe(true);
    expect(r.jump).toBeTruthy();
    expect(r.jump.rel).toBe('src/core.js');
    expect(r.jump.line).toBe(1);
    expect(r.jump.kind).toBe('function');
    expect(r.jump.reason).toContain('imported by this file');
  });

  it('trouve un identifiant terminé par $ — non-régression du `-F` manquant', async () => {
    // sans -F, git traite le motif comme une BRE et `$` devient une ancre : zéro résultat
    const r = await lookup(repo, { symbol: 'data$', file: path.join(repo, 'src/app.js') });
    expect(r.jump).toBeTruthy();
    expect(r.jump.rel).toBe('src/core.js');
  });

  it('tranche un symbole importé d\'un paquet sans proposer de faux locaux', async () => {
    const r = await lookup(repo, { symbol: 'outside', file: path.join(repo, 'src/app.js') });
    expect(r.origin).toEqual({ kind: 'dependency', specifier: 'some-pkg' });
    expect(r.declarations).toEqual([]);
  });

  it('voit un fichier non suivi, mais jamais un node_modules imbriqué', async () => {
    // `:!node_modules` ne suffirait pas : il ne matche que la racine (mesuré)
    fs.writeFileSync(path.join(repo, 'src/fresh.js'), 'export function brandNew() {}\n');
    const r = await lookup(repo, { symbol: 'brandNew', file: path.join(repo, 'src/app.js') });
    expect(r.jump.rel).toBe('src/fresh.js');
    const d = await lookup(repo, { symbol: 'refine', file: path.join(repo, 'src/app.js') });
    expect([...d.declarations, ...d.references].some((h) => h.rel.includes('node_modules'))).toBe(false);
  });

  it('interroge une RÉVISION, où le fichier non suivi n\'existe pas', async () => {
    const r = await lookup(repo, { symbol: 'brandNew', file: path.join(repo, 'src/app.js'), rev: 'HEAD' });
    expect(r.jump).toBe(null);
    expect(r.referenceCount).toBe(0);
    const ok = await lookup(repo, { symbol: 'refine', file: path.join(repo, 'src/app.js'), rev: 'HEAD' });
    expect(ok.jump.rel).toBe('src/core.js');
  });

  it('accepte un NOM DE BRANCHE comme révision (la lentille Branch en donne)', async () => {
    const r = await lookup(repo, { symbol: 'refine', file: path.join(repo, 'src/app.js'), rev: 'HEAD' });
    expect(r.jump).toBeTruthy();
  });

  it('refuse un symbole ou une révision malformés', async () => {
    for (const bad of ['--flag', '', 'a b', '1abc', 'x'.repeat(200)]) {
      expect((await lookup(repo, { symbol: bad, file: path.join(repo, 'src/app.js') })).supported).toBe(false);
    }
    expect((await lookup(repo, { symbol: 'refine', file: path.join(repo, 'src/app.js'), rev: '--upload-pack=x' })).supported).toBe(false);
  });

  it('rend supported:false hors de tout dépôt', async () => {
    const bare = path.join(T, 'nowhere');
    fs.mkdirSync(bare, { recursive: true });
    expect((await lookup(bare, { symbol: 'refine', file: path.join(bare, 'a.js') })).supported).toBe(false);
  });
});

describe('readSlice', () => {
  let repo;
  beforeAll(async () => {
    repo = path.join(T, 'slice');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'big.js'), Array.from({ length: 50 }, (_, i) => 'line ' + (i + 1)).join('\n'));
    await git(repo, 'init', '-q');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', 'init');
  });

  it('rend la fenêtre demandée, 1-based, avec le total', async () => {
    const r = await readSlice(repo, { file: path.join(repo, 'big.js'), from: 10, to: 12 });
    expect(r.supported).toBe(true);
    expect(r.rel).toBe('big.js');
    expect(r.lang).toBe('js');
    expect(r.lines).toEqual(['line 10', 'line 11', 'line 12']);
    expect(r.total).toBe(50);
    expect(r.truncated).toBe(true);
  });

  it('lit à une révision', async () => {
    fs.writeFileSync(path.join(repo, 'big.js'), 'rewritten\n');
    const head = await readSlice(repo, { file: path.join(repo, 'big.js'), rev: 'HEAD', from: 1, to: 1 });
    expect(head.lines).toEqual(['line 1']);
    const wt = await readSlice(repo, { file: path.join(repo, 'big.js'), from: 1, to: 1 });
    expect(wt.lines).toEqual(['rewritten']);
  });

  it('refuse un chemin relatif, un chemin hors dépôt et une révision en flag', async () => {
    expect((await readSlice(repo, { file: 'big.js' })).supported).toBe(false);
    expect((await readSlice(repo, { file: path.join(T, 'outside.js') })).supported).toBe(false);
    expect((await readSlice(repo, { file: path.join(repo, 'big.js'), rev: '--output=/tmp/x' })).supported).toBe(false);
  });

  // Durcissement absent de vcsBlame : sans realpath, un lien symbolique DANS le dépôt suffit
  // à faire sortir la lecture du dépôt.
  it('refuse un lien symbolique qui s\'échappe du dépôt', async () => {
    const secret = path.join(T, 'secret.txt');
    fs.writeFileSync(secret, 'do not read me\n');
    const link = path.join(repo, 'escape.js');
    fs.symlinkSync(secret, link);
    expect((await readSlice(repo, { file: link })).supported).toBe(false);
  });
});
