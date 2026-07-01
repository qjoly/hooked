/*
 * Tests du découpage markdown (mdSegments) et de la coloration syntaxique (highlight).
 * Imports relatifs : ces modules front n'ont pas de dépendance Svelte.
 */
import { describe, it, expect } from 'vitest';
import { mdSegments, mdLite, mdInline, splitMessageImages } from '../src/lib/format.js';
import { highlight, langLabel } from '../src/lib/highlight.js';

describe('splitMessageImages — images jointes séparées du texte', () => {
  it('extrait un chemin d\'image collée et garde le reste du texte', () => {
    const r = splitMessageImages('/Users/x/.claude/hooked/images/paste-abc-12345.png look at this bro');
    expect(r.images).toEqual(['/Users/x/.claude/hooked/images/paste-abc-12345.png']);
    expect(r.text).toBe('look at this bro');
  });
  it('gère plusieurs images', () => {
    const r = splitMessageImages('/h/images/a.png /h/images/b.jpg hello');
    expect(r.images).toEqual(['/h/images/a.png', '/h/images/b.jpg']);
    expect(r.text).toBe('hello');
  });
  it('ne touche pas un texte sans image', () => {
    const r = splitMessageImages('just a normal message about foo.png ideas');
    expect(r.images).toEqual([]);
    expect(r.text).toBe('just a normal message about foo.png ideas');
  });
  it('n\'extrait qu\'un chemin dans un dossier images/ (pas un chemin quelconque)', () => {
    const r = splitMessageImages('/Users/x/Desktop/photo.png check');
    expect(r.images).toEqual([]);
    expect(r.text).toBe('/Users/x/Desktop/photo.png check');
  });
});

describe('mdSegments — découpage texte / code', () => {
  it('sépare texte et bloc de code avec langage', () => {
    const segs = mdSegments('Voici :\n```js\nconst a = 1\n```\nfin');
    expect(segs[0]).toEqual({ type: 'text', html: 'Voici :<br>' });
    expect(segs[1]).toEqual({ type: 'code', lang: 'js', code: 'const a = 1' });
    expect(segs[2].type).toBe('text');
  });

  it('bloc sans langage → lang vide', () => {
    const [seg] = mdSegments('```\nplain text\n```');
    expect(seg).toEqual({ type: 'code', lang: '', code: 'plain text' });
  });

  it('fence sur une seule ligne : pas de faux langage', () => {
    const [seg] = mdSegments('```const x```');
    expect(seg).toEqual({ type: 'code', lang: '', code: 'const x' });
  });

  it('retire le saut de ligne final avant la fence fermante', () => {
    const [seg] = mdSegments('```py\nx = 1\n```');
    expect(seg.code).toBe('x = 1');
  });

  it('ignore les segments de texte vides', () => {
    const segs = mdSegments('```js\na\n```');
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe('code');
  });
});

describe('highlight — coloration', () => {
  it('marque mots-clés, nombres et fonctions (js)', () => {
    const out = highlight('const n = f(2)', 'js');
    expect(out).toContain('<span class="hl-key">const</span>');
    expect(out).toContain('<span class="hl-num">2</span>');
    expect(out).toContain('<span class="hl-fn">f</span>');
  });

  it('échappe le HTML du code', () => {
    const out = highlight('a < b && "<x>"', 'js');
    expect(out).not.toMatch(/<(?!\/?span)/); // aucun « < » brut hors balises <span>
    expect(out).toContain('&lt;');
  });

  it('colore les clés JSON comme attributs', () => {
    const out = highlight('{"name": true}', 'json');
    expect(out).toContain('<span class="hl-attr">&quot;name&quot;</span>');
    expect(out).toContain('<span class="hl-bool">true</span>');
  });

  it('diff : ajout / suppression / hunk ligne à ligne', () => {
    const out = highlight('@@ -1 +1 @@\n+plus\n-moins', 'diff');
    expect(out).toContain('<span class="hl-diff-hunk">');
    expect(out).toContain('<span class="hl-diff-add">+plus</span>');
    expect(out).toContain('<span class="hl-diff-del">-moins</span>');
  });

  it('langage inconnu → moteur générique sans planter', () => {
    expect(() => highlight('a = 1 // x', 'cobol')).not.toThrow();
  });

  it('langLabel : alias → libellé lisible', () => {
    expect(langLabel('ts')).toBe('TypeScript');
    expect(langLabel('sh')).toBe('Shell');
    expect(langLabel('')).toBe('Texte');
  });
});

describe('mdInline — blockquotes', () => {
  it('rend une citation simple dans <blockquote>', () => {
    expect(mdInline('> bonjour')).toBe('<blockquote>bonjour</blockquote>');
  });

  it('regroupe les lignes consécutives en une seule citation (br entre les lignes)', () => {
    expect(mdInline('> une\n> deux')).toBe('<blockquote>une<br>deux</blockquote>');
  });

  it('interprète gras et code à l\'intérieur de la citation', () => {
    expect(mdInline('> **gras** et `code`')).toBe('<blockquote><b>gras</b> et <code>code</code></blockquote>');
  });

  it('gère le marqueur sans espace et les citations imbriquées (>>)', () => {
    expect(mdInline('>a')).toBe('<blockquote>a</blockquote>');
    expect(mdInline('> > niché')).toBe('<blockquote><blockquote>niché</blockquote></blockquote>');
  });

  it('sépare la citation du texte qui suit', () => {
    expect(mdInline('> cité\nnormal')).toBe('<blockquote>cité</blockquote>normal');
  });

  it('échappe le HTML à l\'intérieur de la citation', () => {
    expect(mdInline('> <script>')).toBe('<blockquote>&lt;script&gt;</blockquote>');
  });
});

describe('mdInline — autolink', () => {
  const A = 'target="_blank" rel="noopener noreferrer"';
  it('linkifie une URL http(s)', () => {
    expect(mdInline('voir https://google.com ok'))
      .toBe(`voir <a href="https://google.com" ${A}>https://google.com</a> ok`);
  });
  it('linkifie un domaine nu (schéma https ajouté)', () => {
    expect(mdInline('juste google.com'))
      .toBe(`juste <a href="https://google.com" ${A}>google.com</a>`);
  });
  it('garde la ponctuation de fin de phrase hors du lien', () => {
    expect(mdInline('cf https://x.com/a/b.')).toContain('>https://x.com/a/b</a>.');
  });
  it('équilibre les parenthèses fermantes orphelines', () => {
    expect(mdInline('(voir https://x.com)')).toContain('>https://x.com</a>)');
  });
  it('conserve le & d\'une query string (échappé en &amp;)', () => {
    expect(mdInline('http://x.com/?a=1&b=2'))
      .toContain('href="http://x.com/?a=1&amp;b=2"');
  });
  it('se termine avant un guillemet', () => {
    expect(mdInline('"https://x.com"')).toBe(`&quot;<a href="https://x.com" ${A}>https://x.com</a>&quot;`);
  });
  it('ne linkifie PAS les noms de fichiers (extensions ≠ TLD)', () => {
    for (const f of ['format.js', 'README.md', 'server.cjs', 'app.d.ts', 'package.json'])
      expect(mdInline(f)).toBe(f);
  });
  it('ne linkifie PAS le domaine d\'un email', () => {
    expect(mdInline('a@google.com')).toBe('a@google.com');
  });
});

describe('mdInline — liens markdown & barré', () => {
  const A = 'target="_blank" rel="noopener noreferrer"';
  it('rend un lien markdown [texte](url)', () => {
    expect(mdInline('[#1447](https://github.com/LuccaSA/Infra.Charts/pull/1447)'))
      .toBe(`<a href="https://github.com/LuccaSA/Infra.Charts/pull/1447" ${A}>#1447</a>`);
  });
  it('rend plusieurs liens markdown séparés', () => {
    expect(mdInline('[#1](https://x.com/1) · [#2](https://x.com/2)'))
      .toBe(`<a href="https://x.com/1" ${A}>#1</a> · <a href="https://x.com/2" ${A}>#2</a>`);
  });
  it('applique le gras autour d\'un lien markdown', () => {
    expect(mdInline('**[#1263](https://x.com/1263)**'))
      .toBe(`<b><a href="https://x.com/1263" ${A}>#1263</a></b>`);
  });
  it('n\'autolinkifie pas l\'URL d\'un lien markdown (utilise le texte)', () => {
    expect(mdInline('[Infra.Charts](https://github.com/x)'))
      .toBe(`<a href="https://github.com/x" ${A}>Infra.Charts</a>`);
  });
  it('rend le barré ~~texte~~', () => {
    expect(mdInline('~~#1255~~ · ~~#1259~~')).toBe('<del>#1255</del> · <del>#1259</del>');
  });
  it('refuse un schéma dangereux et garde le texte brut', () => {
    expect(mdInline('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
  });
});

describe('mdLite — compat (inchangé)', () => {
  it('rend toujours <pre><code> et le gras', () => {
    expect(mdLite('**x**')).toBe('<b>x</b>');
    expect(mdLite('```js\na\n```')).toContain('<pre><code>');
  });
});
