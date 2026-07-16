/*
 * Tests de paneActiveStep (server/tmux.js) : la décision pure « le corps de conversation bouge-t-il
 * encore ? » qui alimente `active` dans refineWithPane. Fonction pure (prev, stamp, text) → { stamp,
 * body, active }, testable sans tmux (capture injectée via stamp + texte).
 *
 * Régression ciblée : un pane FIGÉ dont la capture est identique bit-à-bit d'un tick à l'autre (Claude
 * Code récent : le footer d'un pane idle ne « respire » pas → `capture-pane` rend le même texte) DOIT
 * quand même retomber à active=false au tick suivant. L'ancienne dédup clée sur le TEXTE rejouait
 * éternellement le active=true de la 1re observation → la session finie restait 'working' à vie.
 */
import { describe, it, expect } from 'vitest';
import { paneActiveStep } from '../server/index.js';

// le corps est TOUT ce qui précède la dernière invite ❯ ; le streaming grandit là (au-dessus de ❯),
// pas dans le footer (composer/mode) qui, lui, est rogné par conversationBody.
const STATIC = 'réponse finale de Claude\n\n❯ \n\n  ⏵⏵ auto mode on';
const GROWN = 'réponse finale de Claude\net une ligne de plus qui vient de s\'écrire\n\n❯ \n\n  ⏵⏵ auto mode on';

describe('paneActiveStep — détection du mouvement du corps', () => {
  it('1re observation : pas de référence → actif par prudence', () => {
    const e = paneActiveStep(undefined, 1, STATIC);
    expect(e.active).toBe(true);
    expect(e.stamp).toBe(1);
  });

  it('même tick (même stamp) : verdict stable, entrée inchangée', () => {
    const first = paneActiveStep(undefined, 1, STATIC); // active=true (1re obs)
    const same = paneActiveStep(first, 1, STATIC);      // 2e appel MÊME tick (liste + détail)
    expect(same).toBe(first);      // entrée réutilisée telle quelle
    expect(same.active).toBe(true); // le détail ne comparerait pas le corps à lui-même
  });

  it('BUG FIX : capture FRAÎCHE identique bit-à-bit (nouveau stamp) → active=false', () => {
    const t1 = paneActiveStep(undefined, 1, STATIC); // tick 1 : active=true (1re obs)
    const t2 = paneActiveStep(t1, 2, STATIC);        // tick 2 : même texte, ts neuf → corps figé
    expect(t2.active).toBe(false);                   // ← la démotion 'working'→'waiting' peut enfin s'armer
    const t3 = paneActiveStep(t2, 3, STATIC);        // et reste figé
    expect(t3.active).toBe(false);
  });

  it('corps qui grandit (streaming) sur un tick neuf → active=true', () => {
    const t1 = paneActiveStep(undefined, 1, STATIC);
    const t2 = paneActiveStep(t1, 2, GROWN); // le texte final s'écrit → le corps change
    expect(t2.active).toBe(true);
  });
});
