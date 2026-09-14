/*
 * Reprise des sessions pilotées après un redémarrage de hooked.
 *
 * Les sessions vivent dans le processus hooked : `mise deploy` les tue toutes. On rejoue un
 * instantané au démarrage, mais rejouer n'importe quoi coûte cher — chaque reprise spawne un
 * process claude. pickResumable() est la seule décision, donc la seule chose à tester ; le reste
 * (lancer, espacer) est de la plomberie qui consomme de vrais tours.
 */
import { describe, it, expect } from 'vitest';
import { pickResumable } from '../server/agent.js';

const NOW = Date.parse('2026-08-31T12:00:00Z');
const snap = (msAgo, sessions) => ({ ts: new Date(NOW - msAgo).toISOString(), sessions });
const s = (id) => ({ id, cwd: '/tmp/' + id });

describe('pickResumable', () => {
  it('resumes what was live at the last shutdown', () => {
    const out = pickResumable(snap(30000, [s('a'), s('b')]), NOW);
    expect(out.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('wakes nothing when hooked has been off for too long', () => {
    // 12 h est la limite : au-delà, l'instantané ne dit plus rien de l'intention de l'utilisateur
    expect(pickResumable(snap(13 * 3600 * 1000, [s('a')]), NOW)).toEqual([]);
    expect(pickResumable(snap(11 * 3600 * 1000, [s('a')]), NOW)).toHaveLength(1);
  });

  it('caps the boot at 6 sessions', () => {
    const many = Array.from({ length: 20 }, (_, i) => s('s' + i));
    expect(pickResumable(snap(1000, many), NOW)).toHaveLength(6);
  });

  it('keeps the mid-turn flag — those sessions get the automatic Continue', () => {
    const out = pickResumable(snap(1000, [{ ...s('a'), busy: true }, s('b')]), NOW);
    expect(out.map((x) => !!x.busy)).toEqual([true, false]);
  });

  it('drops entries without a usable id or cwd', () => {
    const out = pickResumable(snap(1000, [s('ok'), { id: 'no-cwd' }, { cwd: '/tmp' }, null, { id: '', cwd: '/tmp' }]), NOW);
    expect(out.map((x) => x.id)).toEqual(['ok']);
  });

  it('refuses a snapshot with no or a broken timestamp', () => {
    expect(pickResumable({ sessions: [s('a')] }, NOW)).toEqual([]);
    expect(pickResumable({ ts: 'nope', sessions: [s('a')] }, NOW)).toEqual([]);
  });

  it('refuses a snapshot dated in the future (clock jump)', () => {
    expect(pickResumable(snap(-60000, [s('a')]), NOW)).toEqual([]);
  });

  it('handles junk instead of a snapshot', () => {
    for (const junk of [null, undefined, {}, { sessions: null }, { sessions: [] }, 'nope', 42]) {
      expect(pickResumable(junk, NOW)).toEqual([]);
    }
  });
});
