/*
 * « Terminée » n'est pas « archivée ».
 *
 * Régression vécue : isSessionArchived() assimilait `state === 'ended'` à un archivage. Redémarrer
 * hooked tue les sous-process claude → le hook SessionEnd écrit `ended` → la session quittait la
 * liste active sur le champ, et il fallait aller la repêcher dans l'onglet Archived alors qu'on ne
 * l'avait jamais archivée. Une session qui vient de finir doit rester là où on la cherche.
 */
import { describe, it, expect } from 'vitest';
import { isFinishedAndCold, COLD_MS } from '../src/lib/format.js';

const NOW = Date.parse('2026-08-31T12:00:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();

describe('isFinishedAndCold', () => {
  it('keeps a just-ended session out of the archive', () => {
    // le cas exact d'un redémarrage de hooked
    expect(isFinishedAndCold({ state: 'ended', lastActivity: at(5000) }, NOW)).toBe(false);
  });

  it('archives a session that ended long ago', () => {
    expect(isFinishedAndCold({ state: 'ended', lastActivity: at(COLD_MS + 1000) }, NOW)).toBe(true);
  });

  it('treats the 24h boundary as still warm', () => {
    expect(isFinishedAndCold({ state: 'ended', lastActivity: at(COLD_MS) }, NOW)).toBe(false);
  });

  it('never archives a session that has not finished', () => {
    for (const state of ['working', 'waiting', 'attention', 'background', 'idle']) {
      expect(isFinishedAndCold({ state, lastActivity: at(COLD_MS * 30) }, NOW)).toBe(false);
    }
  });

  it('archives a finished session with no usable timestamp', () => {
    // pas de date = historique, on ne la remonte pas dans la liste active
    expect(isFinishedAndCold({ state: 'past' }, NOW)).toBe(true);
    expect(isFinishedAndCold({ state: 'ended', lastActivity: 'not a date' }, NOW)).toBe(true);
  });

  it('handles a missing session', () => {
    expect(isFinishedAndCold(null, NOW)).toBe(false);
    expect(isFinishedAndCold(undefined, NOW)).toBe(false);
  });
});
