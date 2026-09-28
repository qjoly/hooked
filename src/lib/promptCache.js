// Lifetime model of a Claude Code session's prompt cache. Pure, shared by the server (auto-compact
// scheduler, resume hygiene) and the UI (cache badge, auto-compact explainer).
//
// The prompt cache lives on Anthropic's side, keyed on the exact bytes of the request prefix: the
// process running the session has nothing to do with it. An entry lives one TTL after the START
// of the last request that read or wrote it, and every read renews it for free. So a session is
// "warm" for one TTL after its last request, however long its CLI stays alive. Past that, the next
// message re-writes the whole conversation at the cache-write rate.
//
// TTL: 1 hour for the main conversation on a Claude subscription within plan limits, 5 minutes on
// usage credits / API keys (Claude Code's default; `CLAUDE_CODE_PROMPT_CACHE_TTL` pins it). The
// last response's `usage.cache_creation` says which one the session actually got.

export const CACHE_TTL_MS = { '1h': 3_600_000, '5m': 300_000 };
export const DEFAULT_CACHE_TTL = '1h';

// Price ratios from the API price list, relative to uncached input. A compaction started while the
// cache is warm re-reads the conversation at the read rate: that read costs this share of the cold
// 1h re-write it replaces (the summary it generates comes on top).
export const CACHE_READ_RATIO = 0.1;
export const CACHE_WRITE_1H_RATIO = 2;
export const CACHED_READ_SHARE = CACHE_READ_RATIO / CACHE_WRITE_1H_RATIO;

// Auto-compact fires this long before expiry — at 55 min on the 1h TTL. The margin covers the
// scheduler tick (1 min) and the gap between the timestamp we hold and the request's true start (a
// transcript stamps a response when it lands, not when its request left).
export const COMPACT_LEAD_MS = 5 * 60_000;

// API `usage` of one response → what the cache model needs from it: the prompt the next request
// re-sends (input + cache read + cache write + this output, the CLI's own definition) and which
// TTL the write got. null when the usage is empty (synthetic / error entries).
export function contextFromUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const contextTokens = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens) + n(u.output_tokens);
  if (!contextTokens) return null;
  const cc = u.cache_creation || {};
  const ttl = n(cc.ephemeral_1h_input_tokens) > 0 ? '1h' : n(cc.ephemeral_5m_input_tokens) > 0 ? '5m' : null;
  return { contextTokens, ttl };
}

// { lastRequestAt: ms | ISO, ttl?: '1h' | '5m', contextTokens? } → the cache's state at `now`.
export function promptCacheState(cache, now = Date.now()) {
  const c = cache || {};
  const at = typeof c.lastRequestAt === 'string' ? Date.parse(c.lastRequestAt) : c.lastRequestAt;
  const ttl = CACHE_TTL_MS[c.ttl] ? c.ttl : DEFAULT_CACHE_TTL;
  const contextTokens = Number.isFinite(c.contextTokens) && c.contextTokens > 0 ? c.contextTokens : null;
  if (!Number.isFinite(at) || at <= 0) return { known: false, warm: false, ttl, contextTokens, expiresAt: null, remainingMs: 0 };
  const expiresAt = at + CACHE_TTL_MS[ttl];
  const remainingMs = Math.max(0, expiresAt - now);
  return { known: true, warm: remainingMs > 0, ttl, contextTokens, expiresAt, remainingMs };
}

// Time left on a warm cache, for a countdown shown only in its last `windowMin` minutes (0 = for
// its whole life): an hour away from expiry, the countdown just mirrors the elapsed time.
export function cacheCountdown(cache, windowMin, now = Date.now()) {
  const c = promptCacheState(cache, now);
  if (!c.warm) return null;
  return !windowMin || c.remainingMs <= windowMin * 60_000 ? c.remainingMs : null;
}

// A compaction is due in the last COMPACT_LEAD_MS of a still-warm cache. Never on a cold one: it
// would pay the full re-write it is meant to avoid, on top of the summary.
export function compactDue(cache, now = Date.now()) {
  const c = promptCacheState(cache, now);
  return c.warm && c.remainingMs <= COMPACT_LEAD_MS;
}
