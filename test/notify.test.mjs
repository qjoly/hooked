/*
 * Logique pure des notifications navigateur (src/lib/notify.js).
 *
 * Contrat : une session re-badgée `background` par withBackgroundState (waiting + pane vivant +
 * job/sous-agent de fond ENCORE actif) NE nague PAS — Claude n'est pas bloqué sur toi, un job
 * tourne. Le ping tombe quand le job finit : la session repasse `background` → `waiting`, et cette
 * transition est notifiée par checkNotifications. Une question en attente (hasQuestion) prime et
 * nague quand même, même en background.
 */
import { describe, it, expect } from 'vitest';
import { notifyKeyFor, countsForBadge } from '../src/lib/notify.js';

describe('notifyKeyFor — clé notifiable par session', () => {
  it('background (fin de tour + job de fond) NE nague PAS (Claude n\'est pas bloqué sur toi)', () => {
    const key = notifyKeyFor({ id: 'a', state: 'background', hasQuestion: false });
    expect(key).toBe('');                     // ni notif tant qu'un job de fond tourne…
    expect(countsForBadge(key)).toBe(false);  // …ni badge d'onglet
  });

  it('working et idle ne notifient jamais (pas de spam)', () => {
    expect(notifyKeyFor({ state: 'working', hasQuestion: false })).toBe('');
    expect(notifyKeyFor({ state: 'idle', hasQuestion: false })).toBe('');
    expect(countsForBadge('')).toBe(false);
  });

  it('waiting / attention / ended conservent leur clé', () => {
    expect(notifyKeyFor({ state: 'waiting', hasQuestion: false })).toBe('waiting');
    expect(notifyKeyFor({ state: 'attention', hasQuestion: false })).toBe('attention');
    expect(notifyKeyFor({ state: 'ended', hasQuestion: false })).toBe('ended');
  });

  it('hasQuestion prime sur l\'état (même en background)', () => {
    expect(notifyKeyFor({ state: 'background', hasQuestion: true })).toBe('q');
    expect(notifyKeyFor({ state: 'working', hasQuestion: true })).toBe('q');
  });

  it("'ended' ne compte pas pour le badge d'onglet (session finie ≠ en attente)", () => {
    expect(countsForBadge('ended')).toBe(false);
  });
});
