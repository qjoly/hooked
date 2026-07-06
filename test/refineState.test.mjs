/*
 * Tests de refineWithPane (server/stats.js) : l'affinage de l'état déduit des hooks par la lecture
 * du pane vivant. Fonction pure (state, alive, busy) → testable sans tmux (le busy est injecté).
 *
 * Régression ciblée : une session qui STREAME sa réponse finale (dernier outil passé, pas encore de
 * Stop → état capté 'working', mais footer sans spinner → busy=false) NE DOIT PAS être rétrogradée
 * en 'waiting'. C'est le bug « en écriture affiché en attente ». Cf. commentaire de refineWithPane.
 */
import { describe, it, expect } from 'vitest';
import { refineWithPane } from '../server/index.js';

describe('refineWithPane — affinage de l\'état par le pane', () => {
  it('BUG FIX : session en écriture (working live, busy=false) RESTE working', () => {
    // Claude a fini de réfléchir/d'utiliser des outils et streame son texte final : le footer n'a ni
    // spinner ni « esc to interrupt » (busy=false), mais le tour n'est PAS fini (pas encore de Stop).
    expect(refineWithPane('working', true, false)).toBe('working');
  });

  it('busy=true promeut working / idle / waiting → working (ré-invocation par veilleur, etc.)', () => {
    expect(refineWithPane('working', true, true)).toBe('working');
    expect(refineWithPane('idle', true, true)).toBe('working');
    expect(refineWithPane('waiting', true, true)).toBe('working'); // wakeup/message en file remet à mouliner
  });

  it('idle + pane inactif (busy=false) → waiting : rattrape un Stop raté périmé en idle (5 min)', () => {
    // liveStateFor périme PreToolUse/PostToolUse en 'idle' après 5 min ; un pane vivant mais inactif
    // veut alors dire « en attente de toi ». C'est le filet pour le cas « Stop raté sur pane vivant ».
    expect(refineWithPane('idle', true, false)).toBe('waiting');
  });

  it('waiting capté (Stop autoritaire) + pane inactif reste waiting', () => {
    expect(refineWithPane('waiting', true, false)).toBe('waiting');
  });

  it('pane MORT : working périmé → waiting ; les autres états inchangés', () => {
    expect(refineWithPane('working', false, false)).toBe('waiting');
    expect(refineWithPane('working', false, true)).toBe('waiting'); // busy résiduel ignoré : pane mort
    for (const st of ['idle', 'waiting', 'attention', 'ended', 'past']) {
      expect(refineWithPane(st, false, null)).toBe(st);
    }
  });

  it('ne touche jamais attention / ended / past sur pane vivant, quel que soit busy', () => {
    for (const busy of [true, false, null]) {
      for (const st of ['attention', 'ended', 'past']) {
        expect(refineWithPane(st, true, busy)).toBe(st);
      }
    }
  });

  it('busy=null (pane injoignable) : on ne tranche pas, l\'état capté est conservé', () => {
    expect(refineWithPane('working', true, null)).toBe('working');
    expect(refineWithPane('idle', true, null)).toBe('idle');
    expect(refineWithPane('waiting', true, null)).toBe('waiting');
  });
});
