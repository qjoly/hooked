/*
 * reviewDraft (src/lib/reviewDraft.js) : la sauvegarde de la review en cours des lentilles Ship
 * et Branch — les coches « reviewed » par fichier et l'état de la vue (les commentaires, eux,
 * sont des threads côté serveur). On vérifie
 *   • aller-retour : ce qu'on sauve est ce qu'on relit, par clé ;
 *   • isolation entre deux reviews (deux sessions) ;
 *   • une review vide efface l'entrée (envoyer la review ne laisse pas de brouillon) ;
 *   • plafond : au-delà de 20 brouillons, les plus anciens tombent ;
 *   • robustesse : localStorage illisible/corrompu → listes vides, pas d'exception ;
 *   • l'état de la vue (branche, sélection, fichier, scroll) voyage avec le brouillon, et suffit
 *     à lui seul à le garder — revenir sur la lentille, c'est revenir au même endroit.
 * C'est ce qui garantit qu'un changement d'onglet ou un reload ne perd pas les coches.
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

const draft = (n) => ({ reviewed: ['a' + n + '.js'], view: { file: 'a' + n + '.js' } });

describe('reviewDraft', () => {
  beforeEach(() => { globalThis.localStorage = new LS(); });

  it('relit ce qui a été sauvé, par clé', () => {
    saveDraft('ship:s1', draft(1));
    expect(loadDraft('ship:s1').reviewed).toEqual(['a1.js']);
    expect(loadDraft('ship:s1').view).toEqual({ file: 'a1.js' });
  });

  it('isole deux reviews', () => {
    saveDraft('ship:s1', draft(1));
    saveDraft('branch:s1', draft(2));
    expect(loadDraft('ship:s1').reviewed[0]).toBe('a1.js');
    expect(loadDraft('branch:s1').reviewed[0]).toBe('a2.js');
  });

  it('efface le brouillon quand la review est vide', () => {
    saveDraft('ship:s1', draft(1));
    saveDraft('ship:s1', { reviewed: [] });
    expect(loadDraft('ship:s1')).toEqual({ reviewed: [], view: null });
  });

  it('plafonne le nombre de brouillons gardés', () => {
    for (let i = 0; i < 25; i++) saveDraft('ship:s' + i, draft(i));
    const kept = Object.keys(JSON.parse(globalThis.localStorage.getItem('hooked.reviewDrafts')));
    expect(kept.length).toBe(20);
    expect(loadDraft('ship:s24').reviewed[0]).toBe('a24.js'); // le dernier écrit est gardé
  });

  it('encaisse un stockage corrompu et une clé absente', () => {
    globalThis.localStorage.setItem('hooked.reviewDrafts', '{oops');
    expect(loadDraft('ship:s1')).toEqual({ reviewed: [], view: null });
    expect(loadDraft(null)).toEqual({ reviewed: [], view: null });
  });

  it('garde l’état de la vue, même sans fichier coché', () => {
    const view = { repo: '/r', branch: 'feat', base: 'main', range: { from: 'a1', to: 'b2' }, file: '/r/x.js', scroll: 420 };
    saveDraft('branch:s1', { view });
    expect(loadDraft('branch:s1')).toEqual({ reviewed: [], view });
    // la vue seule tient l'entrée ; la retirer avec une review vide efface tout
    saveDraft('branch:s1', { reviewed: [], view: null });
    expect(loadDraft('branch:s1')).toEqual({ reviewed: [], view: null });
  });

  it('ignore une vue qui n’est pas un objet', () => {
    saveDraft('branch:s1', { reviewed: ['a.js'], view: 'garbage' });
    expect(loadDraft('branch:s1').view).toBe(null);
    expect(loadDraft('branch:s1').reviewed).toEqual(['a.js']);
  });
});
