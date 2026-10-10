/*
 * Tests du découpage markdown (mdSegments) et de la coloration syntaxique (highlight).
 * Le rendu markdown est délégué à markdown-it (GFM complet, html:true) ; on caractérise ici
 * l'intégration hooked : découpage texte/code, liens de session → cartes vivantes, langage des
 * fences (dont mermaid), et les grandes familles de la syntaxe GFM.
 * Imports relatifs : ces modules front n'ont pas de dépendance Svelte.
 */
import { describe, it, expect } from 'vitest';
import { mdSegments, mdInline, splitMessageImages } from '../src/lib/format.js';
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
    expect(segs[0].type).toBe('text');
    expect(segs[0].parts[0].html).toContain('Voici');
    expect(segs[1]).toEqual({ type: 'code', lang: 'js', meta: {}, code: 'const a = 1' });
    expect(segs[2].type).toBe('text');
    expect(segs[2].parts[0].html).toContain('fin');
  });

  it('découpe un lien de session en sous-partie « session » (id + label)', () => {
    const segs = mdSegments('avant [Voir](/session/abc-123) après');
    expect(segs).toHaveLength(1);
    expect(segs[0].parts).toEqual([
      { type: 'html', html: 'avant ' },
      { type: 'session', id: 'abc-123', label: 'Voir' },
      { type: 'html', html: ' après' },
    ]);
  });

  it('laisse les liens ordinaires en html (pas de sous-partie session)', () => {
    const segs = mdSegments('[GitHub](https://github.com/x)');
    expect(segs[0].parts).toHaveLength(1);
    expect(segs[0].parts[0].type).toBe('html');
    expect(segs[0].parts[0].html).toContain('href="https://github.com/x"');
  });

  it('bloc sans langage → lang vide', () => {
    const [seg] = mdSegments('```\nplain text\n```');
    expect(seg).toEqual({ type: 'code', lang: '', meta: {}, code: 'plain text' });
  });

  it('retire le saut de ligne final avant la fence fermante', () => {
    const [seg] = mdSegments('```py\nx = 1\n```');
    expect(seg.code).toBe('x = 1');
  });

  it('conserve `lang: mermaid` — contrat de routage vers <Mermaid>', () => {
    // Markdown.svelte s'appuie sur `s.lang === 'mermaid'` pour rendre le bloc en diagramme.
    const [seg] = mdSegments('```mermaid\ngraph TD\n  A --> B\n```');
    expect(seg).toEqual({ type: 'code', lang: 'mermaid', meta: {}, code: 'graph TD\n  A --> B' });
  });

  it('un bloc de code imbriqué (dans une liste) reste inline, pas extrait', () => {
    // seul le PREMIER NIVEAU devient un segment code (<CodeBlock>) ; l'imbriqué reste <pre>.
    const segs = mdSegments('- item\n    ```\n  nested\n    ```');
    expect(segs.every((s) => s.type === 'text')).toBe(true);
  });
});

describe('mdInline — GFM (markdown-it)', () => {
  it('gras / italique / barré / code inline', () => {
    expect(mdInline('**x**')).toBe('<strong>x</strong>');
    expect(mdInline('*x*')).toBe('<em>x</em>');
    expect(mdInline('~~x~~')).toBe('<s>x</s>');
    expect(mdInline('use `x`')).toBe('use <code>x</code>');
  });

  it('n\'italique PAS un underscore intra-mot (snake_case)', () => {
    expect(mdInline('my_var_name')).toBe('my_var_name');
  });

  it('titres h1–h6', () => {
    expect(mdInline('# Title')).toBe('<h1>Title</h1>');
    expect(mdInline('### Sub')).toBe('<h3>Sub</h3>');
  });

  it('liste non ordonnée', () => {
    const h = mdInline('- a\n- b');
    expect(h).toContain('<ul>');
    expect(h).toContain('<li>a</li>');
    expect(h).toContain('<li>b</li>');
  });

  it('liste ordonnée avec numéro de départ', () => {
    expect(mdInline('3. a\n4. b')).toContain('<ol start="3">');
  });

  it('liste imbriquée', () => {
    const h = mdInline('- a\n  - b');
    expect(h).toContain('<li>a');
    expect(h).toMatch(/<ul>[\s\S]*<li>b<\/li>[\s\S]*<\/ul>/);
  });

  it('cases à cocher GFM (task list)', () => {
    const h = mdInline('- [ ] todo\n- [x] done');
    expect(h).toContain('contains-task-list');
    expect(h).toContain('task-list-item-checkbox');
    expect(h).toMatch(/checked[^>]*type="checkbox"|type="checkbox"[^>]*checked/);
  });

  it('tableau GFM avec alignement', () => {
    const h = mdInline('| a | b |\n|---|:-:|\n| 1 | 2 |');
    expect(h).toContain('<table>');
    expect(h).toContain('text-align:center');
    expect(h).toContain('<td>1</td>');
  });

  it('filet horizontal', () => {
    expect(mdInline('---')).toBe('<hr>');
  });

  it('image → <img> avec loading lazy et classe md-img', () => {
    const h = mdInline('![cat](https://x.com/c.png)');
    expect(h).toContain('src="https://x.com/c.png"');
    expect(h).toContain('class="md-img"');
    expect(h).toContain('loading="lazy"');
  });

  it('laisse passer le HTML brut librement (html:true)', () => {
    expect(mdInline('avant <span style="color:red">RED</span> après'))
      .toContain('<span style="color:red">RED</span>');
  });

  it('paragraphe unique : pas d\'enveloppe <p> ; multi-paragraphes : <p> conservés', () => {
    expect(mdInline('just one line')).toBe('just one line');
    expect(mdInline('para one\n\npara two')).toBe('<p>para one</p>\n<p>para two</p>');
  });
});

describe('mdInline — blockquotes', () => {
  it('rend une citation dans <blockquote>', () => {
    expect(mdInline('> bonjour')).toContain('<blockquote>');
    expect(mdInline('> bonjour')).toContain('bonjour');
  });
  it('interprète gras et code à l\'intérieur de la citation', () => {
    const h = mdInline('> **gras** et `code`');
    expect(h).toContain('<strong>gras</strong>');
    expect(h).toContain('<code>code</code>');
  });
});

describe('mdInline — alertes GitHub (callouts)', () => {
  for (const [marker, type] of [['NOTE', 'note'], ['TIP', 'tip'], ['IMPORTANT', 'important'], ['WARNING', 'warning'], ['CAUTION', 'caution']]) {
    it(`[!${marker}] → div.md-alert-${type} avec titre et contenu`, () => {
      const h = mdInline(`> [!${marker}]\n> Contenu.`);
      expect(h).toContain(`<div class="md-alert md-alert-${type}">`);
      expect(h).toContain('md-alert-title');
      expect(h).toContain('Contenu.');
      expect(h).not.toContain(`[!${marker}]`); // marqueur retiré du rendu
    });
  }
  it('un blockquote ordinaire reste un <blockquote>', () => {
    const h = mdInline('> juste une citation');
    expect(h).toContain('<blockquote>');
    expect(h).not.toContain('md-alert');
  });
  it('conserve le formatage inline dans le corps de l\'alerte', () => {
    const h = mdInline('> [!WARNING]\n> Attention **fort**.');
    expect(h).toContain('md-alert-warning');
    expect(h).toContain('<strong>fort</strong>');
  });
});

describe('mdInline — liens', () => {
  const A = 'target="_blank" rel="noopener noreferrer"';
  it('lien markdown [texte](url) → nouvel onglet', () => {
    expect(mdInline('[#1447](https://github.com/acme/charts/pull/1447)'))
      .toBe(`<a href="https://github.com/acme/charts/pull/1447" ${A}>#1447</a>`);
  });
  it('autolinkifie une URL nue', () => {
    expect(mdInline('voir https://google.com ok'))
      .toContain(`<a href="https://google.com" ${A}>https://google.com</a>`);
  });
  it('lien interne /session/<id> → signature session-link (nav client, pas de nouvel onglet)', () => {
    const h = mdInline('[Voir](/session/abc-123)');
    expect(h).toContain('class="session-link"');
    expect(h).toContain('data-session-link');
    expect(h).not.toContain('target="_blank"');
  });
  it('refuse un schéma dangereux (markdown-it validateLink) et garde le texte', () => {
    expect(mdInline('[x](javascript:alert(1))')).toContain('javascript:alert(1)');
    expect(mdInline('[x](javascript:alert(1))')).not.toContain('href="javascript:');
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
    expect(langLabel('')).toBe('Text');
  });
});
