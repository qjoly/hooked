/*
 * Automatic daily digest generation. Started once at server boot (src/hooks.server.js, prod only).
 * Config lives in settings.json (Settings → Daily digest), read fresh at each tick so toggling
 * `auto` or the hour takes effect without a restart. On boot it backfills yesterday's digest if
 * missing (when auto is on), then fires every day at the configured local hour to generate the
 * previous day. Manual generation via POST /api/digest works regardless of `auto`.
 */
import { startGeneration, readDigest, yesterdayLocal } from './digests.js';
import { readSettings } from './settings.js';

const STARTED = Symbol.for('hooked.digestScheduler.started');

function cfg() {
  const d = readSettings().digest;
  return d && typeof d === 'object' ? d : { auto: true, hour: 7 };
}

// ms until the next occurrence of the configured hour:00 in local time.
function msUntilNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(cfg().hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function generateYesterdayIfMissing() {
  if (!cfg().auto) return;
  const date = yesterdayLocal();
  const existing = readDigest(date);
  if (existing && (existing.status === 'done' || existing.status === 'partial')) return;
  try { startGeneration(date); } catch (_) {}
}

function scheduleNext() {
  const t = setTimeout(() => {
    generateYesterdayIfMissing();
    scheduleNext();
  }, msUntilNextRun());
  if (typeof t.unref === 'function') t.unref(); // don't keep the process alive for the timer alone
}

function startDigestScheduler() {
  if (globalThis[STARTED]) return; // idempotent across HMR / repeated imports
  globalThis[STARTED] = true;
  generateYesterdayIfMissing(); // boot backfill (no-op if auto is off)
  scheduleNext();               // the timer keeps running so toggling `auto` back on works live
}

export { startDigestScheduler };
