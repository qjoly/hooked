/*
 * Model-scoped account quotas (server/utilization.js). The statusline payload only carries the
 * 5h / 7d buckets, so the weekly Fable limit comes from the account usage endpoint (live poll) or,
 * as a fallback, `cachedUsageUtilization` in ~/.claude.json. Both sources share ONE payload shape,
 * so we test the PURE pickers on a real-shape object (no file, no network needed); the reader
 * (readUtilization) just adds an mtime-cached JSON.parse of that file, and server/oauth.js the
 * token lookup whose only pure part (parseCredentials) is covered below.
 */
import { describe, it, expect } from 'vitest';
import { readUtilization, scopedLimit, accountLimit } from '../server/utilization.js';
import { parseCredentials } from '../server/oauth.js';

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

describe('accountLimit', () => {
  it('picks an account-wide bucket by kind (5h = session, 7d = weekly_all)', () => {
    expect(accountLimit('session', UTIL, NOW)).toEqual({
      pct: 0, resetsAt: Date.parse('2026-08-27T11:50:00.483170+00:00'), resetInMin: 260,
    });
    expect(accountLimit('weekly_all', UTIL, NOW).pct).toBe(58);
  });
  it('never returns a model-scoped bucket (those carry a scope)', () => {
    const onlyScoped = { limits: UTIL.limits.filter((l) => l.kind === 'weekly_scoped') };
    expect(accountLimit('weekly_scoped', onlyScoped, NOW)).toBe(null);
  });
  it('degrades to null on a missing / malformed payload', () => {
    expect(accountLimit('session', null, NOW)).toBe(null);
    expect(accountLimit('session', { limits: 'nope' }, NOW)).toBe(null);
  });
});

describe('parseCredentials', () => {
  it('reads the OAuth access token and its expiry', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-tok', expiresAt: 1787904724016 } });
    expect(parseCredentials(raw)).toEqual({ token: 'sk-tok', expiresAtMs: 1787904724016 });
  });
  it('tolerates a missing expiry (we then trust the token until the next read)', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-tok' } });
    expect(parseCredentials(raw)).toEqual({ token: 'sk-tok', expiresAtMs: null });
  });
  it('returns null on anything else (other shapes, garbage, empty)', () => {
    expect(parseCredentials('{}')).toBe(null);
    expect(parseCredentials('{"claudeAiOauth":{}}')).toBe(null);
    expect(parseCredentials('not json')).toBe(null);
    expect(parseCredentials('')).toBe(null);
  });
});

describe('readUtilization', () => {
  it('returns null when the config file is absent', () => {
    expect(readUtilization('/nonexistent/.claude.json')).toBe(null);
  });
});
