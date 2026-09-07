/*
 * Model-scoped account quotas (weekly Fable limit, spend…), with TWO sources:
 *
 *   1. LIVE  — `GET <base>/api/oauth/usage` with Claude Code's own OAuth token (cf. server/oauth.js).
 *      This is the same endpoint the CLI's `/usage` view calls; polled here at most once a minute,
 *      in the background (never blocking a request).
 *   2. CACHE — `cachedUsageUtilization` in ~/.claude.json, the CLI's copy of that same payload.
 *      Fallback when we have no usable token or the network is down.
 *
 * Why the live poll: the statusline payload only carries the 5h / 7d buckets (cf. server/status.js),
 * so per-model weekly limits are invisible there — and the CLI's cache is only rewritten when a
 * session actually opens `/usage`, with a 5 min floor. Relying on it alone left the Fable gauge
 * frozen for hours. Best-effort throughout: any missing key degrades to null.
 */
import fs from 'node:fs';
import { CLAUDE_JSON } from './config.js';
import { statSafe } from './util.js';
import { accessToken } from './oauth.js';

let cache = null; // { key, util }

// `cachedUsageUtilization.utilization` from ~/.claude.json, or null. Cached on mtime+size:
// the file is small (~100 KB) but this is read on every /api/usage poll.
function readUtilization(file = CLAUDE_JSON) {
  const st = statSafe(file);
  if (!st || !st.isFile()) return null;
  const key = file + ':' + st.mtimeMs + ':' + st.size;
  if (cache && cache.key === key) return cache.util;
  let util = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const c = j && j.cachedUsageUtilization;
    util = c && c.utilization ? { ...c.utilization, _fetchedAtMs: c.fetchedAtMs || null } : null;
  } catch (_) { util = null; }
  cache = { key, util };
  return util;
}

// ---------- live poll ----------

const BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const USAGE_URL = process.env.HOOKED_USAGE_URL || BASE + '/api/oauth/usage';
const FETCH_ENABLED = process.env.HOOKED_USAGE_FETCH !== '0';
const LIVE_TTL_MS = 60_000;    // don't re-poll a fresh answer more often than this
const RETRY_MS = 300_000;      // after a failure (no token, offline, 4xx), back off hard
const TIMEOUT_MS = 5000;

let live = null;        // { util } — util carries its own _fetchedAtMs
let inflight = false;
let lastTryMs = 0;
let lastError = null;   // string, shown in /api/usage for debugging (never carries the token)

// Fire-and-forget refresh, rate-limited. Called from currentUtilization on every read: the caller
// keeps serving whatever we already have, and picks up the new value on its next poll.
function kickLiveRefresh(now = Date.now()) {
  if (!FETCH_ENABLED || inflight) return;
  if (now - lastTryMs < (lastError ? RETRY_MS : LIVE_TTL_MS)) return;
  inflight = true;
  lastTryMs = now;
  fetchUsage()
    .then((util) => { live = { util }; lastError = null; })
    .catch((e) => { lastError = String((e && e.message) || e); })
    .finally(() => { inflight = false; });
}

// One GET against the usage endpoint. Resolves with the payload (same shape as the cached
// `utilization` object, `_fetchedAtMs` stamped by us), rejects with a token-free message.
async function fetchUsage() {
  const token = accessToken();
  if (!token) throw new Error('no usable local OAuth token');
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  // A rate-limited / in-band error answers 200 with a fieldless body — same guard as the CLI.
  if (!j || typeof j !== 'object' || !Array.isArray(j.limits)) throw new Error('unexpected payload');
  return { ...j, _fetchedAtMs: Date.now() };
}

// The freshest utilization payload we have — live answer if it beats the CLI's cache, else the
// cache — and kicks a background refresh when ours has gone stale.
function currentUtilization(now = Date.now()) {
  kickLiveRefresh(now);
  const file = readUtilization();
  const liveAt = live && live.util._fetchedAtMs || 0;
  const fileAt = (file && file._fetchedAtMs) || 0;
  if (live && liveAt >= fileAt) return live.util;
  return file;
}

// Where the numbers came from + why the live poll is failing, for the UI's staleness hint.
// { source: 'live' | 'cache' | null, at: ISO | null, error: string | null }
function usageFreshness(now = Date.now()) {
  const util = currentUtilization(now);
  const liveAt = live && live.util._fetchedAtMs || 0;
  const source = util ? (util === (live && live.util) ? 'live' : 'cache') : null;
  return {
    source,
    at: util && util._fetchedAtMs ? new Date(util._fetchedAtMs).toISOString() : null,
    error: liveAt ? null : lastError,   // once we have a live value, past failures are noise
  };
}

// ---------- pickers (pure over a payload) ----------

// Weekly bucket scoped to one model, out of the `limits` array. Entries look like
// { kind: 'weekly_scoped', percent, severity, resets_at, scope: { model: { display_name } } }.
// `name` is matched case-insensitively against the server-supplied display name ('Fable').
// → { pct, label, severity, resetsAt, resetInMin, at } or null when the account has no such bucket.
function scopedLimit(name, util = currentUtilization(), now = Date.now()) {
  const limits = util && Array.isArray(util.limits) ? util.limits : null;
  if (!limits) return null;
  const want = String(name || '').toLowerCase();
  const hit = limits.find((l) => l && l.kind === 'weekly_scoped'
    && String(l.scope?.model?.display_name || '').toLowerCase() === want);
  if (!hit) return null;
  const resetsAt = hit.resets_at != null ? Date.parse(hit.resets_at) : NaN;
  const ok = Number.isFinite(resetsAt);
  return {
    pct: hit.percent == null ? null : Math.round(hit.percent),
    label: hit.scope?.model?.display_name || name,
    severity: hit.severity || null,
    resetsAt: ok ? resetsAt : null,
    resetInMin: ok ? Math.max(0, Math.round((resetsAt - now) / 60000)) : null,
    at: util._fetchedAtMs ? new Date(util._fetchedAtMs).toISOString() : null,
  };
}

// Account-wide buckets ('session' = 5h, 'weekly_all' = 7d) in the shape server/status.js exposes,
// so they can stand in when NO statusline snapshot carries rate limits (all sessions closed).
// → { pct, resetsAt, resetInMin } or null.
function accountLimit(kind, util = currentUtilization(), now = Date.now()) {
  const limits = util && Array.isArray(util.limits) ? util.limits : null;
  if (!limits) return null;
  const hit = limits.find((l) => l && l.kind === kind && !l.scope);
  if (!hit) return null;
  const resetsAt = hit.resets_at != null ? Date.parse(hit.resets_at) : NaN;
  const ok = Number.isFinite(resetsAt);
  return {
    pct: hit.percent == null ? null : Math.round(hit.percent),
    resetsAt: ok ? resetsAt : null,
    resetInMin: ok ? Math.max(0, Math.round((resetsAt - now) / 60000)) : null,
  };
}

export { readUtilization, currentUtilization, usageFreshness, scopedLimit, accountLimit, fetchUsage };
