/*
 * Model-scoped account quotas, read from Claude Code's own usage cache.
 *
 * The statusline payload only carries the 5h / 7d buckets (cf. server/status.js), so the
 * per-model weekly limits (Fable, Opus, …) are invisible there. The CLI does cache the full
 * `/usage` payload in ~/.claude.json under `cachedUsageUtilization`, refreshed on every API
 * response — that's what we read here. Best-effort: any missing key degrades to null.
 */
import fs from 'node:fs';
import { CLAUDE_JSON } from './config.js';
import { statSafe } from './util.js';

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

// Weekly bucket scoped to one model, out of the `limits` array. Entries look like
// { kind: 'weekly_scoped', percent, severity, resets_at, scope: { model: { display_name } } }.
// `name` is matched case-insensitively against the server-supplied display name ('Fable').
// → { pct, label, severity, resetsAt, resetInMin, at } or null when the account has no such bucket.
function scopedLimit(name, util = readUtilization(), now = Date.now()) {
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

export { readUtilization, scopedLimit };
