/*
 * Tests du découpage markdown (mdSegments) et de la coloration syntaxique (highlight).
 * Imports relatifs : ces modules front n'ont pas de dépendance Svelte.
 */
import { describe, it, expect } from 'vitest';
import { mdSegments, mdLite } from '../src/lib/format.js';
import { highlight, langLabel } from '../src/lib/highlight.js';

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

describe('mdLite — compat (inchangé)', () => {
  it('rend toujours <pre><code> et le gras', () => {
    expect(mdLite('**x**')).toBe('<b>x</b>');
    expect(mdLite('```js\na\n```')).toContain('<pre><code>');
  });
});
