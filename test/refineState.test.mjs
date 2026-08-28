/*
 * Tests de refineWithAgent (server/stats.js) : l'affinage de l'état déduit des hooks par l'état réel
 * publié par l'Agent SDK. Fonction pure (state, alive, sdkState) → testable sans lancer de session.
 *
 * Ce que la migration hors tmux change ici. L'ancien refineWithPane devait DEVINER l'état depuis
 * l'écran du TUI et prenait donc deux signaux distincts : `busy` (une ligne de spinner est-elle
 * peinte dans le footer ?) et `active` (le corps de la conversation a-t-il bougé entre deux
 * captures ?). Il en fallait deux parce qu'« absence de spinner » couvrait deux cas indistinguables
 * — Claude streame sa réponse finale, ou le tour est fini — d'où une comparaison de captures pour
 * les séparer, et deux bugs symétriques (session en écriture affichée « waiting », session finie
 * bloquée sur « working »).
 *
 * Le SDK publie l'état directement (`session_state_changed` : idle / running / requires_action). Un
 * seul signal, autoritaire, plus d'heuristique — donc plus de « on ne tranche pas » : les cas
 * ambigus de l'ancienne fonction n'existent plus. Ne restent que les cas de bord réels : session non
 * pilotée (ouverte à la main dans un terminal, ou terminée) et 'ended' qu'on ne touche jamais.
 */
import { describe, it, expect } from 'vitest';
import { refineWithAgent } from '../server/index.js';

describe('refineWithAgent — affinage de l\'état par le registre de sessions', () => {
  it('running → working, quel que soit l\'état capté par les hooks', () => {
    // Un wakeup de fond (Monitor / ScheduleWakeup / message en file) remet Claude à réfléchir AVANT
    // tout nouveau hook UserPromptSubmit : l'état capté est encore 'waiting', le SDK dit 'running'.
    for (const st of ['working', 'idle', 'waiting', 'background', 'attention', 'past']) {
      expect(refineWithAgent(st, true, 'running')).toBe('working');
    }
  });

  it('requires_action → attention (question / plan / permission en attente)', () => {
    for (const st of ['working', 'idle', 'waiting', 'past']) {
      expect(refineWithAgent(st, true, 'requires_action')).toBe('attention');
    }
  });

  it('idle → waiting : rattrape un Stop raté ou absent', () => {
    // Sans cette démotion, une session finie sans Stop capté resterait 'working' à vie — c'est le
    // bug que l'ancienne comparaison de captures servait à rattraper.
    expect(refineWithAgent('working', true, 'idle')).toBe('waiting');
    expect(refineWithAgent('idle', true, 'idle')).toBe('waiting');
    expect(refineWithAgent('waiting', true, 'idle')).toBe('waiting');
  });

  it('idle ne dégrade PAS un attention capté par les hooks', () => {
    // Une question posée par un sous-agent peut arriver dans les évènements avant que l'état de la
    // session principale ne repasse à 'running' : on ne la fait pas disparaître de la file d'attente.
    expect(refineWithAgent('attention', true, 'idle')).toBe('attention');
  });

  it('session non pilotée : working périmé → waiting, les autres états inchangés', () => {
    // Vrai pour une session terminée ET pour une session qu'un utilisateur a ouverte à la main dans
    // un terminal : elle reste visible et à jour via les hooks, mais on ne peut rien affirmer de
    // plus qu'eux — un 'working' hérité d'un dernier hook sans Stop est simplement périmé.
    expect(refineWithAgent('working', false, null)).toBe('waiting');
    for (const st of ['idle', 'waiting', 'attention', 'past']) {
      expect(refineWithAgent(st, false, null)).toBe(st);
    }
  });

  it('ended n\'est jamais touché', () => {
    for (const alive of [true, false]) {
      for (const sdk of ['running', 'idle', 'requires_action', null]) {
        expect(refineWithAgent('ended', alive, sdk)).toBe('ended');
      }
    }
  });

  it('sdkState inconnu / absent sur session vivante : l\'état capté est conservé', () => {
    for (const st of ['working', 'idle', 'waiting', 'past']) {
      expect(refineWithAgent(st, true, null)).toBe(st);
      expect(refineWithAgent(st, true, 'something-new')).toBe(st);
    }
  });
});
