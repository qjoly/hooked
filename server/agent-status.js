/*
 * Status snapshots for DRIVEN sessions (Agent SDK).
 *
 * `statusline-tap.sh` can never write one for them: the statusline is a TUI render, and an SDK
 * session has no TUI. Everything that only lived there — context-window fill, freshly rendered
 * 5h / 7d rate limits — was therefore frozen on whatever terminal was last opened by hand.
 *
 * The SDK exposes exactly that data as control requests on the `Query` (`st.q`):
 *   - `getContextUsage()` → { totalTokens, rawMaxTokens, percentage, … }   (stable)
 *   - `usage_EXPERIMENTAL_…()` → { rate_limits: { five_hour, seven_day, … }, session: { cost } }
 *
 * We write them to STATUS_DIR **in the statusline format**, one file per session, overwritten on
 * each refresh: `server/status.js`, `server/stats.js` and the UI know nothing of the producer, and
 * both worlds (tapped TUI / SDK session) converge on the same file.
 *
 * Best-effort throughout: a control request that fails leaves the previous snapshot in place.
 */
import fs from 'node:fs';
import path from 'node:path';
import { STATUS_DIR } from './config.js';

// The method name carries its own warning: it is experimental and will be renamed when the API
// stabilises. So we look it up by prefix rather than hard-coding it, and its absence is not an
// error — rate limits then fall back to the `/api/oauth/usage` poll (server/utilization.js).
const USAGE_METHOD_PREFIX = 'usage_EXPERIMENTAL';

const THROTTLE_MS = 15_000;   // max rate mid-turn (context moves, but not second by second)

// ISO 8601 → epoch SECONDS, the unit the statusline writes (status.js accepts s or ms).
function toEpochSeconds(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}

// One SDK rate-limit window ({ utilization, resets_at }) → the statusline shape
// ({ used_percentage, resets_at }). null when the window is missing or empty.
function toRateLimitWindow(w) {
  if (!w || w.utilization == null) return null;
  return { used_percentage: w.utilization, resets_at: toEpochSeconds(w.resets_at) };
}

/**
 * SDK payloads → a statusline-shaped snapshot. PURE (tested without launching a session).
 * `ctx` = getContextUsage() response, `usage` = usage_EXPERIMENTAL_…() response, both optional.
 * Returns null when there is nothing worth writing.
 */
function buildSnapshot(id, { ctx, usage, model, effort } = {}, now = Date.now()) {
  if (!id) return null;
  const rl = usage && usage.rate_limits_available ? usage.rate_limits : null;
  const fiveHour = rl ? toRateLimitWindow(rl.five_hour) : null;
  const sevenDay = rl ? toRateLimitWindow(rl.seven_day) : null;
  const hasCtx = ctx && ctx.percentage != null;
  if (!hasCtx && !fiveHour && !sevenDay) return null;
  const snap = { session_id: id, source: 'sdk', ts: Math.round(now / 1000) };
  if (model) snap.model = { id: model, display_name: model };
  if (effort) snap.effort = { level: effort };
  if (hasCtx) {
    snap.context_window = {
      used_percentage: ctx.percentage,
      context_window_size: ctx.rawMaxTokens || ctx.maxTokens || null,
    };
  }
  if (fiveHour || sevenDay) snap.rate_limits = { five_hour: fiveHour, seven_day: sevenDay };
  return snap;
}

// Atomic write (tmp + rename): the reader caches on mtime+size and must never see truncated JSON.
function writeSnapshot(snap, statusDir = STATUS_DIR) {
  if (!snap || !/^[A-Za-z0-9._-]+$/.test(snap.session_id || '')) return false;
  const dest = path.join(statusDir, snap.session_id + '.json');
  const tmp = dest + '.tmp';
  try {
    fs.mkdirSync(statusDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, dest);
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

// Name of the usage method on the Query, looked up by prefix (plain object OR class instance:
// prototype methods are not enumerable, hence getOwnPropertyNames).
function usageMethodName(q) {
  const proto = Object.getPrototypeOf(q);
  const names = Object.getOwnPropertyNames(q).concat(proto ? Object.getOwnPropertyNames(proto) : []);
  return names.find((k) => k.startsWith(USAGE_METHOD_PREFIX) && typeof q[k] === 'function') || null;
}

// Both control requests, each isolated: one failing must not deprive us of the other.
async function pollQuery(q) {
  const usageMethod = usageMethodName(q);
  const [ctx, usage] = await Promise.all([
    typeof q.getContextUsage === 'function' ? q.getContextUsage().catch(() => null) : null,
    usageMethod ? q[usageMethod]().catch(() => null) : null,
  ]);
  return { ctx, usage };
}

/**
 * Refresh the snapshot of one registry entry. Fire-and-forget: the caller (readLoop) never awaits
 * it. Throttled, one flight in the air per session; `force` (end of turn) skips the throttle but
 * never the in-flight guard.
 */
function refreshAgentStatus(st, force = false, now = Date.now()) {
  if (!st || !st.id || !st.q || st.ended) return;
  if (st.statusInflight) return;
  if (!force && now - (st.statusAt || 0) < THROTTLE_MS) return;
  st.statusInflight = true;
  st.statusAt = now;
  pollQuery(st.q)
    .then(({ ctx, usage }) => {
      writeSnapshot(buildSnapshot(st.id, { ctx, usage, model: st.model, effort: st.effort }));
    })
    .catch(() => {})
    .finally(() => { st.statusInflight = false; });
}

export { refreshAgentStatus, buildSnapshot, writeSnapshot };
