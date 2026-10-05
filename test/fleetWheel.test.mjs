import { describe, it, expect } from 'vitest';
import { wheelModel, faviconSvg } from '../src/lib/fleetWheel.js';

const S = (id, state, extra = {}) => ({ id, state, lastActivity: '2026-10-05T10:00:00Z', ...extra });

describe('wheelModel', () => {
  it('lays sessions clockwise by family, needs-you first, and tiles the whole circle', () => {
    const m = wheelModel([S('a', 'idle'), S('b', 'working'), S('c', 'waiting', { hasQuestion: true }), S('d', 'waiting'), S('e', 'ended')]);
    expect(m.segments.map((g) => g.family)).toEqual(['attention', 'waiting', 'working', 'idle', 'ended']);
    expect(m.segments[0].start).toBe(0);
    expect(m.segments.at(-1).end).toBe(1);
    m.segments.slice(1).forEach((g, i) => expect(g.start).toBe(m.segments[i].end));
    expect(m.segments.filter((g) => g.needsYou).map((g) => g.id)).toEqual(['c', 'd']);
    const fam = Object.fromEntries(m.families.map((f) => [f.key, f.count]));
    expect(fam).toEqual({ attention: 1, waiting: 1, working: 1, bgjob: 0, idle: 1, ended: 1 });
  });

  it('marks snoozed sessions quiet and survives an empty fleet', () => {
    const m = wheelModel([S('a', 'waiting')], (s) => s.id === 'a');
    expect(m.segments[0].quiet).toBe(true);
    expect(wheelModel([]).total).toBe(0);
  });
});

describe('faviconSvg', () => {
  it('draws one arc per present family, a full ring when only one is present', () => {
    const colors = { attention: '#c43d4d', waiting: '#e1901f', working: '#418d50', bgjob: '#9e59b3', idle: '#92a1a9', ended: '#96684f' };
    const two = faviconSvg(wheelModel([S('a', 'attention'), S('b', 'working')]).families, colors);
    expect(two.match(/stroke-width="8"/g)).toHaveLength(2);
    expect(two).toContain('#c43d4d');
    const one = faviconSvg(wheelModel([S('a', 'working')]).families, colors);
    expect(one).toContain('stroke="#418d50" stroke-width="8"');
  });
});
