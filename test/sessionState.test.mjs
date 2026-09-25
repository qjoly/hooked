/*
 * Prédicats d'état de session (src/lib/format.js) : une seule définition pour la sidebar, le Deck,
 * le badge de la TopBar et la palette — chacun avait la sienne, et trois copies d'une règle finissent
 * toujours par diverger.
 */
import { describe, it, expect } from 'vitest';
import { isActiveSession, needsDecision, sessionDot } from '../src/lib/format.js';

describe('session state predicates', () => {
  it('isActiveSession : la session fait ou attend quelque chose', () => {
    for (const state of ['working', 'background', 'waiting', 'attention']) expect(isActiveSession({ state })).toBe(true);
    for (const state of ['idle', 'ended', 'past']) expect(isActiveSession({ state })).toBe(false);
  });

  it('needsDecision : question, plan, permission, ou tour rendu', () => {
    expect(needsDecision({ state: 'working', hasQuestion: true })).toBe(true);
    expect(needsDecision({ state: 'working', hasPlan: true })).toBe(true);
    expect(needsDecision({ state: 'attention' })).toBe(true);
    expect(needsDecision({ state: 'waiting' })).toBe(true);
    expect(needsDecision({ state: 'working' })).toBe(false);
    expect(needsDecision({ state: 'ended' })).toBe(false);
  });

  it('sessionDot : la décision prime sur l’état live, ended et idle ferment la liste', () => {
    expect(sessionDot({ state: 'working', hasQuestion: true })).toBe('attention');
    expect(sessionDot({ state: 'attention' })).toBe('attention');
    expect(sessionDot({ state: 'working' })).toBe('working');
    expect(sessionDot({ state: 'background' })).toBe('bgjob');
    expect(sessionDot({ state: 'waiting' })).toBe('waiting');
    expect(sessionDot({ state: 'ended' })).toBe('ended');
    expect(sessionDot({ state: 'idle' })).toBe('idle');
    expect(sessionDot({ state: 'past' })).toBe('idle');
  });
});
