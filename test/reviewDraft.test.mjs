/*
 * reviewDraft (src/lib/reviewDraft.js) : la sauvegarde de la review en cours des lentilles Ship
 * et Branch. On vérifie
 *   • aller-retour : ce qu'on sauve est ce qu'on relit, par clé ;
 *   • isolation entre deux reviews (deux sessions) ;
 *   • une review vide efface l'entrée (envoyer la review ne laisse pas de brouillon) ;
 *   • plafond : au-delà de 20 brouillons, les plus anciens tombent ;
 *   • robustesse : localStorage illisible/corrompu → listes vides, pas d'exception.
 * C'est ce qui garantit qu'un changement d'onglet ou un reload ne perd pas des commentaires.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// mini-localStorage (le module ne tourne que côté navigateur)
class LS {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}
globalThis.localStorage = new LS();

const { loadDraft, saveDraft } = await import('../src/lib/reviewDraft.js');

const draft = (n) => ({ comments: [{ id: 'c' + n, file: 'a.js', text: 'nope' }], reviewed: ['a.js'] });

describe('reviewDraft', () => {
  beforeEach(() => { globalThis.localStorage = new LS(); });

  it('relit ce qui a été sauvé, par clé', () => {
    saveDraft('ship:s1', draft(1));
    expect(loadDraft('ship:s1').comments).toEqual([{ id: 'c1', file: 'a.js', text: 'nope' }]);
    expect(loadDraft('ship:s1').reviewed).toEqual(['a.js']);
  });

  it('isole deux reviews', () => {
    saveDraft('ship:s1', draft(1));
    saveDraft('branch:s1', draft(2));
    expect(loadDraft('ship:s1').comments[0].id).toBe('c1');
    expect(loadDraft('branch:s1').comments[0].id).toBe('c2');
  });

  it('efface le brouillon quand la review est vide', () => {
    saveDraft('ship:s1', draft(1));
    saveDraft('ship:s1', { comments: [], reviewed: [] });
    expect(loadDraft('ship:s1')).toEqual({ comments: [], reviewed: [] });
  });

  it('plafonne le nombre de brouillons gardés', () => {
    for (let i = 0; i < 25; i++) saveDraft('ship:s' + i, draft(i));
    const kept = Object.keys(JSON.parse(globalThis.localStorage.getItem('hooked.reviewDrafts')));
    expect(kept.length).toBe(20);
    expect(loadDraft('ship:s24').comments[0].id).toBe('c24'); // le dernier écrit est gardé
  });

  it('encaisse un stockage corrompu et une clé absente', () => {
    globalThis.localStorage.setItem('hooked.reviewDrafts', '{oops');
    expect(loadDraft('ship:s1')).toEqual({ comments: [], reviewed: [] });
    expect(loadDraft(null)).toEqual({ comments: [], reviewed: [] });
  });
});
