/*
 * Tests de refineWithPane (server/stats.js) : l'affinage de l'état déduit des hooks par la lecture
 * du pane vivant. Fonction pure (state, alive, busy, active) → testable sans tmux (busy/active injectés).
 *
 * Deux régressions ciblées, symétriques, toutes deux quand le footer n'a PAS de spinner (busy=false) :
 *  1. EN ÉCRITURE — Claude streame sa réponse finale (dernier outil passé, pas encore de Stop). Le
 *     corps de conversation grandit (active=true) → NE DOIT PAS retomber en 'waiting' (bug 52e5e68).
 *  2. TERMINÉ — le tour est fini mais le Stop a été raté/absent. Le corps est figé (active=false) →
 *     DOIT retomber en 'waiting' (bug « working après tour fini » ; sans ça la session reste working
 *     pour toujours puisque plus rien ne la rétrograde). C'est le signal que `active` apporte.
 */
import { describe, it, expect } from 'vitest';
import { refineWithPane } from '../server/index.js';

describe('refineWithPane — affinage de l\'état par le pane', () => {
  it('BUG FIX 1 : en écriture (working, busy=false, corps qui BOUGE) RESTE working', () => {
    // Claude a fini de réfléchir/d'utiliser des outils et streame son texte final : ni spinner ni
    // « esc to interrupt » (busy=false), mais le corps grandit (active=true) → tour PAS fini.
    expect(refineWithPane('working', true, false, true)).toBe('working');
  });

  it('BUG FIX 2 : tour terminé (working, busy=false, corps FIGÉ) → waiting', () => {
    // Réponse finale affichée, composer prêt, corps statique (active=false) : le Stop a été raté/absent
    // mais le pane ne bouge plus → la session attend. Sans cette démotion elle resterait working à vie.
    expect(refineWithPane('working', true, false, false)).toBe('waiting');
  });

  it('busy=true promeut working / idle / waiting → working (quel que soit `active`)', () => {
    for (const active of [true, false, null]) {
      expect(refineWithPane('working', true, true, active)).toBe('working');
      expect(refineWithPane('idle', true, true, active)).toBe('working');
      expect(refineWithPane('waiting', true, true, active)).toBe('working'); // wakeup/message en file
    }
  });

  it('idle + pane inactif figé (busy=false, active=false) → waiting : rattrape un Stop raté', () => {
    expect(refineWithPane('idle', true, false, false)).toBe('waiting');
  });

  it('waiting capté (Stop autoritaire) reste waiting, corps figé ou non', () => {
    expect(refineWithPane('waiting', true, false, false)).toBe('waiting');
    expect(refineWithPane('waiting', true, false, true)).toBe('waiting');
  });

  it('busy=false mais active=null (1re observation / injoignable) : on ne rétrograde PAS', () => {
    // Pas encore de recul sur le mouvement du corps → prudence : on garde l'état capté (pas de démotion
    // hâtive d'un tour peut-être en cours). Le tick suivant, `active` deviendra true/false et tranchera.
    expect(refineWithPane('working', true, false, null)).toBe('working');
    expect(refineWithPane('idle', true, false, null)).toBe('idle');
  });

  it('pane MORT : working périmé → waiting ; les autres états inchangés', () => {
    expect(refineWithPane('working', false, false, false)).toBe('waiting');
    expect(refineWithPane('working', false, true, true)).toBe('waiting'); // busy/active résiduels ignorés : pane mort
    for (const st of ['idle', 'waiting', 'attention', 'ended', 'past']) {
      expect(refineWithPane(st, false, null, null)).toBe(st);
    }
  });

  it('ne touche jamais attention / ended / past sur pane vivant, quels que soient busy/active', () => {
    for (const busy of [true, false, null]) {
      for (const active of [true, false, null]) {
        for (const st of ['attention', 'ended', 'past']) {
          expect(refineWithPane(st, true, busy, active)).toBe(st);
        }
      }
    }
  });

  it('busy=null (pane injoignable) : on ne tranche pas, l\'état capté est conservé', () => {
    expect(refineWithPane('working', true, null, false)).toBe('working');
    expect(refineWithPane('idle', true, null, false)).toBe('idle');
    expect(refineWithPane('waiting', true, null, false)).toBe('waiting');
  });
});
