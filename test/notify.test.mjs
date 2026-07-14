/*
 * Logique pure des notifications navigateur (src/lib/notify.js).
 *
 * Régression ciblée : une session « tour terminé » re-badgée `background` par
 * withBackgroundState (waiting + pane vivant + job de fond) DOIT rester notifiable.
 * Auparavant notifyKeyFor n'avait pas de cas 'background' → '' → aucune notif ni badge
 * d'onglet, alors que la même session sans job de fond (waiting) notifiait. Bug « job en
 * background, action required, pas notifié ».
 */
import { describe, it, expect } from 'vitest';
import { notifyKeyFor, countsForBadge, NOTIFY_KINDS } from '../src/lib/notify.js';

describe('notifyKeyFor — clé notifiable par session', () => {
  it('background (fin de tour + job de fond) est notifiable', () => {
    const key = notifyKeyFor({ id: 'a', state: 'background', hasQuestion: false });
    expect(key).toBe('background');
    expect(key).not.toBe('');
    expect(NOTIFY_KINDS[key]).toBeDefined(); // une entrée d'affichage existe
    expect(countsForBadge(key)).toBe(true);  // compte pour le badge d'onglet
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
