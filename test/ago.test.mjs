/*
 * Elapsed-time labels (src/lib/format.js). `ago` is the long form used across the app; `agoShort`
 * is the compact one of the session sidebar, where the unit sticks to the number and "ago" goes.
 */
import { describe, it, expect } from 'vitest';
import { ago, agoShort, fmtSpan } from '../src/lib/format.js';

const NOW = Date.parse('2026-09-23T10:00:00Z');
const at = (sec) => new Date(NOW - sec * 1000).toISOString();

describe('ago', () => {
  it('keeps its long form', () => {
    expect(ago(at(3), NOW)).toBe('just now');
    expect(ago(at(42), NOW)).toBe('42s ago');
    expect(ago(at(5 * 60), NOW)).toBe('5 min ago');
    expect(ago(at(3 * 3600), NOW)).toBe('3 h ago');
    expect(ago(at(2 * 86400), NOW)).toBe('2 d ago');
    expect(ago(null, NOW)).toBe('—');
  });
});

describe('agoShort', () => {
  it('drops the space and the "ago"', () => {
    expect(agoShort(at(3), NOW)).toBe('now');
    expect(agoShort(at(42), NOW)).toBe('42s');
    expect(agoShort(at(5 * 60), NOW)).toBe('5min');
    expect(agoShort(at(3 * 3600), NOW)).toBe('3h');
    expect(agoShort(at(2 * 86400), NOW)).toBe('2d');
    expect(agoShort(null, NOW)).toBe('—');
  });
});

describe('fmtSpan', () => {
  it('formats a duration in its coarsest unit, compact on demand', () => {
    expect(fmtSpan(41 * 60_000 + 30_000)).toBe('41 min');
    expect(fmtSpan(41 * 60_000 + 30_000, '')).toBe('41min');
    expect(fmtSpan(45_000, '')).toBe('45s');
    expect(fmtSpan(-5)).toBe('0s');
  });
});
