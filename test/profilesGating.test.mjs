/*
 * What a session on a `compatible` profile (LM Studio…) must not get from the Anthropic-only
 * machinery: a warm-cache hold on a model switch, auto-compact, a cache countdown, a price, a
 * quota query. Each decision is pure over the registry entry or the data, pinned without launching
 * a session.
 */
import { describe, it, expect } from 'vitest';
import { shouldAutoCompact, decideModelSwitch } from '../server/agent.js';
import { sessionCache } from '../server/stats.js';
import { priceFor, costForUsage } from '../server/pricing.js';
import { pollQuery } from '../server/agent-status.js';

const NOW = Date.parse('2026-09-23T10:00:00Z');
const min = (n) => n * 60_000;
// An idle session whose cache would be due for a compact (the same fixture as autoCompact.test.mjs).
const waiting = (over = {}) => ({
  ended: false, sawMsg: true, busy: false, pendingAsk: null, autoCompacting: false,
  lastRequestAt: NOW - min(56), lastUsage: { contextTokens: 300_000, ttl: '1h' },
  ...over,
});
const ON = { enabled: true, minContextK: 100 };

describe('auto-compact', () => {
  it('compacts an Anthropic session in that state, and never a compatible one', () => {
    expect(shouldAutoCompact(waiting(), ON, NOW)).toBe(true);
    expect(shouldAutoCompact(waiting({ profileKind: 'anthropic' }), ON, NOW)).toBe(true);
    expect(shouldAutoCompact(waiting({ profileKind: 'compatible' }), ON, NOW)).toBe(false);
  });
});

describe('the hold on a model switch', () => {
  const input = { source: 'sdk', prompt_cache_warm: true, context_tokens: 200_000, from_model: 'opus', to_model: 'sonnet' };

  it('holds an Anthropic session whose cache is warm, unless forced', () => {
    expect(decideModelSwitch({ modelSwitch: { force: false } }, input).allow).toBe(false);
    expect(decideModelSwitch({ modelSwitch: { force: false }, profileKind: 'anthropic' }, input).allow).toBe(false);
    expect(decideModelSwitch({ modelSwitch: { force: true } }, input)).toEqual({ allow: true });
  });

  it('lets a compatible session switch at once: the CLI calls its cache warm, but there is none', () => {
    expect(decideModelSwitch({ modelSwitch: { force: false }, profileKind: 'compatible' }, input)).toEqual({ allow: true });
  });

  it('still leaves a switch the user typed in the session alone', () => {
    expect(decideModelSwitch({ modelSwitch: { force: false }, profileKind: 'compatible' }, { ...input, source: 'command' })).toBe(null);
  });
});

describe('sessionCache', () => {
  const s = { lastUsage: { ts: '2026-09-23T09:30:00Z', ttl: '1h', contextTokens: 50_000 } };
  const live = { lastRequestAt: NOW, ttl: '1h', contextTokens: 60_000 };

  it('is the cache clock of a session on the default profile or an anthropic one', () => {
    expect(sessionCache(s, live).contextTokens).toBe(60_000);
    expect(sessionCache(s, live, null).contextTokens).toBe(60_000);
    expect(sessionCache(s, null, { kind: 'anthropic' }).contextTokens).toBe(50_000);
  });

  it('is none for a compatible one, from the registry as from the transcript', () => {
    expect(sessionCache(s, live, { kind: 'compatible' })).toBeNull();
    expect(sessionCache(s, null, { kind: 'compatible' })).toBeNull();
  });
});

describe('pricing', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };

  it('charges nothing for a model of a compatible server, which carries a provider prefix', () => {
    for (const m of ['qwen/qwen3-coder-30b', 'qwen/qwen3.8-27b', 'meta-llama/llama-3.1-8b']) {
      expect(priceFor(m)).toEqual({ in: 0, out: 0 });
      expect(costForUsage(usage, m).total).toBe(0);
    }
  });

  it('keeps pricing a Claude model, even through a gateway that prefixes it', () => {
    expect(priceFor('anthropic/claude-opus-4-8')).toEqual({ in: 5, out: 25 });
    expect(priceFor('anthropic/claude-sonnet-4-6')).toEqual({ in: 3, out: 15 });
    expect(costForUsage(usage, 'claude-opus-4-8').total).toBeGreaterThan(0);
  });

  it('keeps the Opus fallback for an unknown id without a prefix', () => {
    expect(priceFor('unknown-model')).toEqual({ in: 5, out: 25 });
    expect(priceFor('')).toEqual({ in: 5, out: 25 });
  });
});

describe('pollQuery', () => {
  const fakeQuery = () => {
    const calls = [];
    return {
      calls,
      getContextUsage: async () => { calls.push('ctx'); return { percentage: 20 }; },
      usage_EXPERIMENTAL_test: async () => { calls.push('usage'); return { rate_limits_available: true, rate_limits: {} }; },
    };
  };

  it('asks for the context and the usage by default', async () => {
    const q = fakeQuery();
    const r = await pollQuery(q);
    expect(q.calls.sort()).toEqual(['ctx', 'usage']);
    expect(r.usage).toBeTruthy();
  });

  it('skips the usage question for a session with no Anthropic account, and still reads the context', async () => {
    const q = fakeQuery();
    const r = await pollQuery(q, { usage: false });
    expect(q.calls).toEqual(['ctx']);
    expect(r.ctx).toEqual({ percentage: 20 });
    expect(r.usage).toBeNull();
  });
});
