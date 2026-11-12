import { describe, it, expect } from 'vitest';
import { sectionOf, snoozePresets, wakeLabel } from '../src/lib/sidebarSections.js';

const s = (id, state, extra = {}) => ({ id, state, ...extra });
const flags = (archivedIds = [], snoozedIds = []) => ({
  archived: (x) => archivedIds.includes(x.id),
  snoozed: (x) => snoozedIds.includes(x.id),
});

describe('sectionOf', () => {
  it('sorts a lone session by its state', () => {
    expect(sectionOf([s('a', 'attention')], flags())).toBe('waiting');
    expect(sectionOf([s('a', 'waiting')], flags())).toBe('waiting');
    expect(sectionOf([s('a', 'idle', { hasQuestion: true })], flags())).toBe('waiting');
    expect(sectionOf([s('a', 'working')], flags())).toBe('working');
    expect(sectionOf([s('a', 'background')], flags())).toBe('working');
    expect(sectionOf([s('a', 'idle')], flags())).toBe('idle');
    expect(sectionOf([s('a', 'ended')], flags())).toBe('idle');
  });

  it('lets archive win over snooze, and snooze over a pending decision', () => {
    expect(sectionOf([s('a', 'attention')], flags(['a'], ['a']))).toBe('archived');
    expect(sectionOf([s('a', 'attention')], flags([], ['a']))).toBe('snoozed');
  });

  it('places a group by its most pressing awake member', () => {
    const g = [s('m', 'idle'), s('c1', 'working'), s('c2', 'waiting')];
    expect(sectionOf(g, flags())).toBe('waiting');
    expect(sectionOf(g, flags([], ['c2']))).toBe('working');
    expect(sectionOf(g, flags(['c2']))).toBe('working');
    expect(sectionOf(g, flags(['c1', 'c2']))).toBe('idle');
  });

  it('shelves a group only when every live member is snoozed or archived', () => {
    const g = [s('m', 'waiting'), s('c', 'working')];
    expect(sectionOf(g, flags([], ['m']))).toBe('working');
    expect(sectionOf(g, flags(['c'], ['m']))).toBe('snoozed');
    expect(sectionOf(g, flags(['m', 'c']))).toBe('archived');
  });
});

describe('snoozePresets', () => {
  it('offers this evening, tomorrow and Monday on a Wednesday morning', () => {
    const now = new Date(2026, 10, 11, 10, 0).getTime();
    const p = snoozePresets(now);
    expect(p.map((x) => x.label)).toEqual(['1 hour', '3 hours', 'This evening', 'Tomorrow', 'Monday']);
    expect(new Date(p[2].until).getHours()).toBe(18);
    expect(new Date(p[4].until).getDay()).toBe(1);
    expect(new Date(p[4].until).getDate()).toBe(16);
  });

  it('drops this evening when it is too close and Monday when it is tomorrow', () => {
    const sunday = new Date(2026, 10, 15, 16, 0).getTime();
    expect(snoozePresets(sunday).map((x) => x.label)).toEqual(['1 hour', '3 hours', 'Tomorrow']);
  });

  it('points Monday to next week when today is Monday', () => {
    const monday = new Date(2026, 10, 16, 8, 0).getTime();
    const p = snoozePresets(monday).find((x) => x.label === 'Monday');
    expect(new Date(p.until).getDate()).toBe(23);
  });
});

describe('wakeLabel', () => {
  const now = new Date(2026, 10, 11, 10, 0).getTime();
  it('reads as a clock today, tmrw, a weekday, then a date', () => {
    expect(wakeLabel(new Date(2026, 10, 11, 14, 5).getTime(), now)).toBe('14:05');
    expect(wakeLabel(new Date(2026, 10, 12, 9, 0).getTime(), now)).toBe('tmrw 9:00');
    expect(wakeLabel(new Date(2026, 10, 16, 9, 0).getTime(), now)).toBe('Mon 9:00');
    expect(wakeLabel(new Date(2026, 10, 25, 9, 0).getTime(), now)).toBe('25/11');
  });
});
