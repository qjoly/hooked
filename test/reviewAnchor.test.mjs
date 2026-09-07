/*
 * reanchor (src/lib/reviewAnchor.js) — le ré-ancrage des threads de revue quand le code a bougé.
 * Contrat : ancre confirmée par le snippet → inchangée ; snippet déplacé et retrouvé UNE fois →
 * l'ancre suit ; disparu ou ambigu → `outdated` (l'ancre historique est conservée pour le
 * libellé « was +Lx–y »).
 */
import { describe, it, expect } from 'vitest';
import { reanchor } from '../src/lib/reviewAnchor.js';

const L = (t) => t.split('\n');

describe('reanchor', () => {
  const lines = L('a\nb\nc\nd\ne');

  it('confirme une ancre dont le snippet matche encore', () => {
    expect(reanchor({ start: 2, end: 3, snippet: 'b\nc' }, lines)).toEqual({ start: 2, end: 3, outdated: false });
  });

  it('suit le snippet déplacé (retrouvé une seule fois)', () => {
    const moved = L('x\ny\na\nb\nc\nd\ne'); // tout a glissé de 2
    expect(reanchor({ start: 2, end: 3, snippet: 'b\nc' }, moved)).toEqual({ start: 4, end: 5, outdated: false });
  });

  it('déclare outdated un snippet disparu, en gardant l\'ancre historique', () => {
    expect(reanchor({ start: 2, end: 3, snippet: 'b\nGONE' }, lines)).toEqual({ start: 2, end: 3, outdated: true });
  });

  it('déclare outdated un snippet AMBIGU (plusieurs occurrences ailleurs)', () => {
    const dup = L('q\nb\nc\nq\nb\nc');
    expect(reanchor({ start: 9, end: 10, snippet: 'b\nc' }, dup)).toEqual({ start: 9, end: 10, outdated: true });
  });

  it('à l\'ancre d\'origine, un match suffit même si le snippet existe aussi ailleurs', () => {
    const dup = L('b\nc\nz\nb\nc');
    expect(reanchor({ start: 1, end: 2, snippet: 'b\nc' }, dup)).toEqual({ start: 1, end: 2, outdated: false });
  });

  it('recale `end` sur la taille du snippet quand l\'ancre stockée était incohérente', () => {
    expect(reanchor({ start: 2, end: 9, snippet: 'b\nc' }, lines)).toEqual({ start: 2, end: 3, outdated: false });
  });

  it('sans snippet, l\'ancre est gardée telle quelle (rien à vérifier)', () => {
    expect(reanchor({ start: 4, end: 4, snippet: '' }, lines)).toEqual({ start: 4, end: 4, outdated: false });
    expect(reanchor({ start: 4, end: 4 }, lines)).toEqual({ start: 4, end: 4, outdated: false });
  });

  it('gère un snippet en fin de fichier et une ancre hors bornes', () => {
    expect(reanchor({ start: 5, end: 5, snippet: 'e' }, lines)).toEqual({ start: 5, end: 5, outdated: false });
    expect(reanchor({ start: 99, end: 99, snippet: 'e' }, lines)).toEqual({ start: 5, end: 5, outdated: false });
  });
});
