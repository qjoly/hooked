/*
 * Auto-compact (server/agent.js): with the hooked setting on, `/compact` a large session left
 * waiting on the user just before its prompt cache expires; and the hold on a model switch while
 * the cache is warm. Both decisions are pure over the registry entry, so they are pinned here
 * without launching a session — the scheduler tick and the SDK hook are plumbing around them.
 */
import { describe, it, expect } from 'vitest';
import { shouldAutoCompact, decideModelSwitch } from '../server/agent.js';

const NOW = Date.parse('2026-09-23T10:00:00Z');
const min = (n) => n * 60_000;
const ON = { enabled: true, minContextK: 100 };
// A driven session idle after a turn, 300k tokens of context, cache written 56 min ago on the 1h TTL.
const waiting = (over = {}) => ({
  ended: false, sawMsg: true, busy: false, pendingAsk: null, autoCompacting: false,
  lastRequestAt: NOW - min(56), lastUsage: { contextTokens: 300_000, ttl: '1h' },
  ...over,
});

describe('shouldAutoCompact', () => {
  it('does nothing while the setting is off', () => {
    expect(shouldAutoCompact(waiting(), { enabled: false, minContextK: 100 }, NOW)).toBe(false);
    expect(shouldAutoCompact(waiting(), undefined, NOW)).toBe(false);
    expect(shouldAutoCompact(null, ON, NOW)).toBe(false);
  });

  it('compacts in the last minutes of a warm cache — at 55 min on the 1h TTL — and only then', () => {
    expect(shouldAutoCompact(waiting({ lastRequestAt: NOW - min(30) }), ON, NOW)).toBe(false);
    expect(shouldAutoCompact(waiting({ lastRequestAt: NOW - min(54) - 1000 }), ON, NOW)).toBe(false);
    expect(shouldAutoCompact(waiting({ lastRequestAt: NOW - min(55) }), ON, NOW)).toBe(true);
    expect(shouldAutoCompact(waiting(), ON, NOW)).toBe(true);
  });

  it('never on a cold cache — compacting would pay the re-write it avoids', () => {
    expect(shouldAutoCompact(waiting({ lastRequestAt: NOW - min(61) }), ON, NOW)).toBe(false);
  });

  it('skips sessions below the size threshold, and sessions of unknown size', () => {
    expect(shouldAutoCompact(waiting({ lastUsage: { contextTokens: 99_999, ttl: '1h' } }), ON, NOW)).toBe(false);
    expect(shouldAutoCompact(waiting({ lastUsage: { contextTokens: 100_000, ttl: '1h' } }), ON, NOW)).toBe(true);
    expect(shouldAutoCompact(waiting({ lastUsage: { contextTokens: 40_000, ttl: '1h' } }), { enabled: true, minContextK: 0 }, NOW)).toBe(true);
    // just compacted: the cache clock and the size are unknown until the next real turn
    expect(shouldAutoCompact(waiting({ lastRequestAt: null, lastUsage: null }), ON, NOW)).toBe(false);
  });

  it('waits while the session is busy, blocked on a question, not started, or already compacting', () => {
    expect(shouldAutoCompact(waiting({ busy: true }), ON, NOW)).toBe(false);
    expect(shouldAutoCompact(waiting({ pendingAsk: { kind: 'question' } }), ON, NOW)).toBe(false);
    expect(shouldAutoCompact(waiting({ sawMsg: false }), ON, NOW)).toBe(false);
    expect(shouldAutoCompact(waiting({ autoCompacting: true }), ON, NOW)).toBe(false);
  });

  it('follows the 5-minute TTL when that is what the session got', () => {
    const fiveMin = { contextTokens: 300_000, ttl: '5m' };
    expect(shouldAutoCompact(waiting({ lastRequestAt: NOW - min(4), lastUsage: fiveMin }), ON, NOW)).toBe(true);
    expect(shouldAutoCompact(waiting({ lastRequestAt: NOW - min(6), lastUsage: fiveMin }), ON, NOW)).toBe(false);
  });
});

describe('decideModelSwitch', () => {
  // PreModelSwitchHookInput as the CLI sends it for a headless set_model.
  const input = (over = {}) => ({
    source: 'sdk', from_model: 'claude-opus-5', to_model: 'claude-fable-5-1',
    prompt_cache_warm: true, cache_ttl: '1h', context_tokens: 380_000, estimated_cache_write_usd: 7.6,
    ...over,
  });

  it('has no opinion on switches hooked did not initiate', () => {
    expect(decideModelSwitch({ modelSwitch: { force: false } }, input({ source: 'command' }))).toBe(null);
    expect(decideModelSwitch({ modelSwitch: null }, input())).toBe(null);
    expect(decideModelSwitch(null, input())).toBe(null);
  });

  it('holds a warm-cache switch, with the CLI figures for the confirm dialog', () => {
    expect(decideModelSwitch({ modelSwitch: { force: false } }, input())).toEqual({
      allow: false,
      held: { fromModel: 'claude-opus-5', toModel: 'claude-fable-5-1', contextTokens: 380_000, estimatedCacheWriteUsd: 7.6, cacheTtl: '1h' },
    });
  });

  it('allows a cold-cache switch, and a confirmed one', () => {
    expect(decideModelSwitch({ modelSwitch: { force: false } }, input({ prompt_cache_warm: false }))).toEqual({ allow: true });
    expect(decideModelSwitch({ modelSwitch: { force: true } }, input())).toEqual({ allow: true });
  });
});
