/*
 * reviewState (src/lib/reviewState.js) : les coches « reviewed » des lentilles Ship et Branch,
 * liées au CONTENU relu et plus seulement au chemin du fichier. On vérifie
 *   • un fichier coché à l'instant T n'est plus coché après une nouvelle modification (T+1) ;
 *   • revenu à l'état T (prompt/commit précédent), il est de nouveau coché ;
 *   • décocher n'oublie que l'état courant, pas les états signés précédemment ;
 *   • plafond des états mémorisés par fichier ;
 *   • toMap : les entrées de l'ancien format (simples chemins) sont ignorées, sinon la coche
 *     redeviendrait éternelle.
 * C'est ce qui garantit qu'un fichier retouché repasse dans la file de relecture.
 */
import { describe, it, expect } from 'vitest';
import { fingerprint, isReviewed, toggleReviewed, toMap, toEntries, nextUnreviewed }
  from '../src/lib/reviewState.js';

const T = fingerprint(['old', 'new at T']);
const T1 = fingerprint(['old', 'new at T+1']);

describe('reviewState', () => {
  it('décoche un fichier modifié après sa relecture', () => {
    const m = toggleReviewed(new Map(), 'a.js', T);
    expect(isReviewed(m, 'a.js', T)).toBe(true);
    expect(isReviewed(m, 'a.js', T1)).toBe(false); // modifié depuis → à relire
  });

  it('recoche quand on revient à un état déjà relu', () => {
    let m = toggleReviewed(new Map(), 'a.js', T);
    m = toggleReviewed(m, 'a.js', T1);            // relu de nouveau après modif
    expect(isReviewed(m, 'a.js', T)).toBe(true);  // l'état T reste signé
    expect(isReviewed(m, 'a.js', T1)).toBe(true);
  });

  it('décocher n oublie que l état courant', () => {
    let m = toggleReviewed(new Map(), 'a.js', T);
    m = toggleReviewed(m, 'a.js', T1);
    m = toggleReviewed(m, 'a.js', T1);            // on décoche l'état courant
    expect(isReviewed(m, 'a.js', T1)).toBe(false);
    expect(isReviewed(m, 'a.js', T)).toBe(true);
  });

  it('ne compte pas un fichier sans empreinte connue', () => {
    const m = toggleReviewed(new Map(), 'a.js', T);
    expect(isReviewed(m, 'a.js', null)).toBe(false);
    expect(isReviewed(m, 'b.js', T)).toBe(false);
    expect(toggleReviewed(new Map(), 'a.js', null).size).toBe(0);
  });

  it('plafonne les états mémorisés par fichier', () => {
    let m = new Map();
    for (let i = 0; i < 20; i++) m = toggleReviewed(m, 'a.js', fingerprint(['v' + i]));
    expect(m.get('a.js').length).toBe(12);
    expect(isReviewed(m, 'a.js', fingerprint(['v19']))).toBe(true);
    expect(isReviewed(m, 'a.js', fingerprint(['v0']))).toBe(false); // le plus ancien est tombé
  });

  it('ignore les coches de l ancien format au rechargement', () => {
    expect(toMap(['a.js', 'b.js']).size).toBe(0);
    expect(toMap(null).size).toBe(0);
    const m = toggleReviewed(new Map(), 'a.js', T);
    expect(isReviewed(toMap(toEntries(m)), 'a.js', T)).toBe(true); // aller-retour stockage
  });

  it('distingue deux contenus et pas seulement leur longueur', () => {
    expect(fingerprint(['abc'])).not.toBe(fingerprint(['abd']));
    expect(fingerprint(['a', 'bc'])).not.toBe(fingerprint(['ab', 'c'])); // séparateur entre pièces
  });
});

// Auto-advance after "Mark reviewed": it must land on the next UN-reviewed file, not on the
// immediate neighbour when that one is already ticked.
describe('nextUnreviewed', () => {
  const files = ['a.js', 'b.js', 'c.js', 'd.js'];

  it('skips files already reviewed', () => {
    const done = new Set(['b.js', 'c.js']);
    expect(nextUnreviewed(files, 0, (f) => done.has(f))).toBe(3); // a → d, skipping b and c
  });

  it('takes the immediate neighbour when it is not reviewed', () => {
    expect(nextUnreviewed(files, 1, () => false)).toBe(2);
  });

  it('stays put when everything ahead is reviewed', () => {
    const done = new Set(['c.js', 'd.js']);
    expect(nextUnreviewed(files, 1, (f) => done.has(f))).toBe(-1);
    expect(nextUnreviewed(files, 3, () => false)).toBe(-1); // last file: nothing after
  });
});
