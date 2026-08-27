/*
 * Model-scoped account quotas (server/utilization.js). The statusline payload only carries the
 * 5h / 7d buckets, so the weekly Fable limit is read from `cachedUsageUtilization` in
 * ~/.claude.json. We test the PURE picker on a real-shape payload (no file needed); the reader
 * (readUtilization) just adds an mtime-cached JSON.parse of that file.
 */
import { describe, it, expect } from 'vitest';
import { readUtilization, scopedLimit } from '../server/utilization.js';

const NOW = Date.parse('2026-08-27T07:30:00Z');

// Real shape of `cachedUsageUtilization.utilization`, trimmed to what we read: the `limits`
// array mixes the account-wide buckets (session / weekly_all) with the model-scoped ones.
const UTIL = {
  _fetchedAtMs: Date.parse('2026-08-27T07:22:31.752Z'),
  limits: [
    { kind: 'session', group: 'session', percent: 0, severity: 'normal', resets_at: '2026-08-27T11:50:00.483170+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 58, severity: 'normal', resets_at: '2026-08-27T12:00:00.483202+00:00', scope: null },
    {
      kind: 'weekly_scoped', group: 'weekly', percent: 99.6, severity: 'critical',
      resets_at: '2026-08-27T12:00:00.483494+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    },
  ],
};

describe('scopedLimit', () => {
  it('picks the weekly bucket of one model, rounds the percentage and dates the reset', () => {
    expect(scopedLimit('Fable', UTIL, NOW)).toEqual({
      pct: 100,
      label: 'Fable',
      severity: 'critical',
      resetsAt: Date.parse('2026-08-27T12:00:00.483494+00:00'),
      resetInMin: 270,
      at: '2026-08-27T07:22:31.752Z',
    });
  });
  it('matches the display name case-insensitively', () => {
    expect(scopedLimit('fable', UTIL, NOW).pct).toBe(100);
  });
  it('never returns an account-wide bucket (session / weekly_all are not model-scoped)', () => {
    expect(scopedLimit('Opus', UTIL, NOW)).toBe(null);
    expect(scopedLimit('', UTIL, NOW)).toBe(null);
  });
  it('degrades to null on a missing / malformed payload', () => {
    expect(scopedLimit('Fable', null, NOW)).toBe(null);
    expect(scopedLimit('Fable', {}, NOW)).toBe(null);
    expect(scopedLimit('Fable', { limits: 'nope' }, NOW)).toBe(null);
  });
  it('keeps the gauge usable when the bucket has no reset date', () => {
    const noReset = { limits: [{ kind: 'weekly_scoped', percent: 12, resets_at: null, scope: { model: { display_name: 'Fable' } } }] };
    expect(scopedLimit('Fable', noReset, NOW)).toMatchObject({ pct: 12, resetsAt: null, resetInMin: null, at: null });
  });
});

describe('readUtilization', () => {
  it('returns null when the config file is absent', () => {
    expect(readUtilization('/nonexistent/.claude.json')).toBe(null);
  });
});
