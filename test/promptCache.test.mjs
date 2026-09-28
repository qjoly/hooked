/*
 * Prompt-cache lifetime model (src/lib/promptCache.js): the one piece of arithmetic behind the
 * cache badge, the auto-compact scheduler and the resume hygiene. Pure, so pinned here.
 */
import { describe, it, expect } from 'vitest';
import {
  promptCacheState, compactDue, contextFromUsage, cacheCountdown, COMPACT_LEAD_MS, CACHE_TTL_MS,
} from '../src/lib/promptCache.js';

const NOW = Date.parse('2026-09-23T10:00:00Z');
const min = (n) => n * 60_000;

describe('promptCacheState', () => {
  it('is warm for one TTL after the last request, cold after', () => {
    const at = NOW - min(40);
    const warm = promptCacheState({ lastRequestAt: at, ttl: '1h', contextTokens: 300_000 }, NOW);
    expect(warm).toMatchObject({ known: true, warm: true, ttl: '1h', contextTokens: 300_000, remainingMs: min(20) });
    expect(warm.expiresAt).toBe(at + CACHE_TTL_MS['1h']);
    const cold = promptCacheState({ lastRequestAt: NOW - min(61), ttl: '1h' }, NOW);
    expect(cold).toMatchObject({ known: true, warm: false, remainingMs: 0 });
  });

  it('accepts an ISO timestamp and honours a 5-minute TTL', () => {
    const c = promptCacheState({ lastRequestAt: new Date(NOW - min(4)).toISOString(), ttl: '5m' }, NOW);
    expect(c).toMatchObject({ warm: true, ttl: '5m', remainingMs: min(1) });
  });

  it('defaults to the 1-hour TTL when the write TTL is unknown', () => {
    expect(promptCacheState({ lastRequestAt: NOW - min(30) }, NOW)).toMatchObject({ warm: true, ttl: '1h' });
    expect(promptCacheState({ lastRequestAt: NOW - min(30), ttl: 'bogus' }, NOW).ttl).toBe('1h');
  });

  it('is unknown (never warm) without a last request', () => {
    expect(promptCacheState(null, NOW)).toMatchObject({ known: false, warm: false, expiresAt: null });
    expect(promptCacheState({ lastRequestAt: 'not a date', contextTokens: 10 }, NOW)).toMatchObject({ known: false, contextTokens: 10 });
    expect(promptCacheState({ lastRequestAt: NOW, contextTokens: 0 }, NOW).contextTokens).toBe(null);
  });
});

describe('compactDue', () => {
  const cache = (agoMs) => ({ lastRequestAt: NOW - agoMs, ttl: '1h' });

  it('fires only inside the last lead minutes of a warm cache', () => {
    expect(compactDue(cache(min(30)), NOW)).toBe(false);
    expect(compactDue(cache(min(60) - COMPACT_LEAD_MS - 1000), NOW)).toBe(false);
    expect(compactDue(cache(min(60) - COMPACT_LEAD_MS), NOW)).toBe(true);
    expect(compactDue(cache(min(59)), NOW)).toBe(true);
  });

  it('never fires on a cold cache — compacting would pay the full re-write it is meant to avoid', () => {
    expect(compactDue(cache(min(60)), NOW)).toBe(false);
    expect(compactDue(cache(min(180)), NOW)).toBe(false);
    expect(compactDue(null, NOW)).toBe(false);
  });
});

describe('contextFromUsage', () => {
  it('sums what the next request re-sends and reads the TTL off cache_creation', () => {
    expect(contextFromUsage({
      input_tokens: 32, cache_read_input_tokens: 329_313, cache_creation_input_tokens: 6_234, output_tokens: 3_420,
      cache_creation: { ephemeral_1h_input_tokens: 6_234, ephemeral_5m_input_tokens: 0 },
    })).toEqual({ contextTokens: 338_999, ttl: '1h' });
    expect(contextFromUsage({ input_tokens: 10, output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 4 } }))
      .toEqual({ contextTokens: 15, ttl: '5m' });
  });

  it('leaves the TTL unknown when nothing was written, and ignores empty usages', () => {
    expect(contextFromUsage({ input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 })).toEqual({ contextTokens: 101, ttl: null });
    expect(contextFromUsage({ input_tokens: 0, output_tokens: 0 })).toBe(null);
    expect(contextFromUsage(null)).toBe(null);
  });
});


describe('cacheCountdown', () => {
  const cache = (agoMin, ttl = '1h') => ({ lastRequestAt: NOW - min(agoMin), ttl });

  it('shows the time left once it falls inside the window', () => {
    expect(cacheCountdown(cache(50), 15, NOW)).toBe(min(10));
    expect(cacheCountdown(cache(45), 15, NOW)).toBe(min(15));
  });

  it('hides a cache that has more time left than the window', () => {
    expect(cacheCountdown(cache(1), 15, NOW)).toBe(null);
  });

  it('shows every warm cache when the window is 0 (always)', () => {
    expect(cacheCountdown(cache(1), 0, NOW)).toBe(min(59));
  });

  it('shows a 5-minute TTL from the start: it never exceeds the window', () => {
    expect(cacheCountdown(cache(1, '5m'), 15, NOW)).toBe(min(4));
  });

  it('hides a cold or unknown cache', () => {
    expect(cacheCountdown(cache(61), 0, NOW)).toBe(null);
    expect(cacheCountdown(null, 0, NOW)).toBe(null);
    expect(cacheCountdown({}, 15, NOW)).toBe(null);
  });
});
