/*
 * 5-hour window management.
 *
 * Claude's usage window is anchored to your FIRST message and lasts 5h — it is not aligned on
 * round hours. So the time of the day's first prompt decides where every later boundary falls,
 * and every boundary hands out a fresh budget. Over a 9h working day at most three windows can
 * overlap (a fourth would need 10h), and which three you get is decided before you start working.
 *
 * Picking the anchor: the middle window always contains the same amount of work whatever the
 * anchor, so the only real choice is how the remaining work time splits between the first and the
 * last window. We maximise the SMALLEST share (maximin) because it is optimal for every burn rate
 * at once — favouring one window only pays off for one assumed rate. For 09:00-12:00 + 14:00-18:00
 * that lands on 06:00, splitting the day 2h / 3h / 2h.
 *
 * The scheduler then holds ONE invariant, which covers the morning warm-up and a boundary falling
 * during a break with no special case: between the anchor and the end of the working day, never
 * leave the 5h window closed. A throwaway `claude -p` ping opens it — it must stay tiny, since it
 * spends the very budget it just unlocked.
 *
 * Deliberately off by default: it spawns a Claude process on a timer.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HOOKED_DIR, isValidModelArg } from './config.js';
import { readSettings } from './settings.js';
import { currentUtilization, accountLimit } from './utilization.js';
import { setSessionMeta } from './sessionMeta.js';

const WINDOW_MIN = 300;            // the 5h window, in minutes
const TICK_MS = 60_000;
const MIN_GAP_MS = 15 * 60_000;    // never two pings closer than this, whatever the usage data says
const PING_TIMEOUT_MS = 120_000;
const STATE_FILE = path.join(HOOKED_DIR, 'warmup.json');
const TIMER = Symbol.for('hooked.warmup.timer');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PING_PROMPT = 'Reply with exactly: ok';

// ---------- pure planning (minutes since local midnight) ----------

function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function fmtHm(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440; // a window can end past midnight
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

function hmOf(ms) {
  const d = new Date(ms);
  return fmtHm(d.getHours() * 60 + d.getMinutes());
}

// [["09:00","12:00"], …] → [[540, 720], …], sorted, overlaps merged, malformed entries dropped.
function warmupSlots(raw) {
  const out = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    const a = Array.isArray(s) ? parseHm(s[0]) : null;
    const b = Array.isArray(s) ? parseHm(s[1]) : null;
    if (a == null || b == null || b <= a) continue;
    out.push([a, b]);
  }
  out.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  return merged;
}

function workBetween(slots, from, to) {
  let n = 0;
  for (const [a, b] of slots) n += Math.max(0, Math.min(b, to) - Math.max(a, from));
  return n;
}

// The chain of 5h windows a first prompt at `anchor` produces, keeping only those that carry work.
// Assumes the invariant below holds — i.e. every boundary is consumed, by a real prompt or a ping.
function warmupPlan(slots, anchor) {
  if (!slots.length || anchor == null) return [];
  const dayEnd = slots[slots.length - 1][1];
  const windows = [];
  for (let s = anchor; s < dayEnd; s += WINDOW_MIN) {
    const work = workBetween(slots, s, s + WINDOW_MIN);
    if (work > 0) windows.push({ start: s, end: s + WINDOW_MIN, work });
  }
  return windows;
}

function betterScore(x, y) {
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// Best anchor: most windows first, then the most even split, then the latest anchor (same plan at
// 06:00 beats 04:20 — less dead time, and a ping closer to when the machine is actually awake).
function warmupAnchor(slots, step = 5) {
  if (!slots.length) return null;
  const firstStart = slots[0][0];
  let best = null;
  for (let a = firstStart; a > firstStart - WINDOW_MIN && a >= 0; a -= step) {
    const windows = warmupPlan(slots, a);
    if (!windows.length) continue;
    const score = [windows.length, Math.min(...windows.map((w) => w.work)), a];
    if (!best || betterScore(score, best.score)) best = { anchor: a, score, windows };
  }
  return best ? best.anchor : null;
}

// ---------- state ----------

function cfg() {
  const c = readSettings().warmup;
  return c && typeof c === 'object' ? c : null;
}

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch (_) {
    return {};
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  try {
    fs.mkdirSync(HOOKED_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + '\n');
  } catch (_) {}
  return next;
}

function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function anchorFor(c, slots) {
  const auto = warmupAnchor(slots);
  if (c && c.mode === 'fixed') {
    const at = parseHm(c.at);
    if (at != null) return at;
  }
  return auto;
}

// ---------- the decision ----------

// Why we are (not) pinging right now — pure over its inputs, so it is unit-testable AND can be
// shown in the UI. A scheduler that silently does nothing is unfalsifiable; this one always says
// what it decided and on what grounds.
function warmupDecision(c, now, util, state) {
  if (!c || !c.enabled) return { act: false, reason: 'disabled' };
  const slots = warmupSlots(c.workHours);
  if (!slots.length) return { act: false, reason: 'no working hours configured' };
  if (!Array.isArray(c.days) || !c.days.includes(now.getDay())) {
    return { act: false, reason: `${DAYS[now.getDay()]} is not a working day` };
  }
  const anchor = anchorFor(c, slots);
  const cur = now.getHours() * 60 + now.getMinutes();
  const dayEnd = slots[slots.length - 1][1];
  if (cur < anchor) return { act: false, reason: `holding until ${fmtHm(anchor)}` };
  if (cur > dayEnd) return { act: false, reason: `working day ended at ${fmtHm(dayEnd)}` };

  const since = now.getTime() - (Number(state.lastPingAt) || 0);
  if (since < MIN_GAP_MS) return { act: false, reason: `pinged ${Math.round(since / 60000)} min ago` };

  const ms = now.getTime();
  const five = accountLimit('session', util, ms);
  // An open window needs no help: the next prompt of the day will chain onto its boundary anyway.
  if (five && five.resetsAt && five.resetsAt > ms) {
    return { act: false, reason: `window already open until ${hmOf(five.resetsAt)}` };
  }
  const weekly = accountLimit('weekly_all', util, ms);
  const guard = Number(c.skipIfWeeklyOver) || 0;
  if (guard > 0 && weekly && weekly.pct != null && weekly.pct >= guard) {
    return { act: false, reason: `weekly budget at ${weekly.pct}% (guard at ${guard}%)` };
  }
  // No usage payload at all (offline, no OAuth token): we cannot see whether a window is open, so
  // fall back to the weaker guarantee of one ping per day rather than pinging every 15 min.
  if (!util && state.lastPingDay === localDay(now)) {
    return { act: false, reason: 'no usage data — already pinged today' };
  }
  return { act: true, reason: five ? 'window closed' : 'no window data — opening one' };
}

// ---------- the ping ----------

// `claude -p --output-format json` emits an SDKResultMessage envelope: `session_id` sits right
// next to `total_cost_usd`, so the id of the throwaway ping session comes for free from the same
// parse — no need to correlate by prompt text or timestamp. Extract by braces rather than a bare
// JSON.parse — same reason as digests.js's objFromBraces: a login-shell preamble (zoxide/p10k/nvm)
// can prepend noise to stdout under launchd/systemd. Pure so it's unit-testable without spawning
// a process.
function parsePingOutput(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return { cost: null, sessionId: null };
  try {
    const j = JSON.parse(stdout.slice(start, end + 1));
    const cost = typeof j?.total_cost_usd === 'number' ? j.total_cost_usd : null;
    const sessionId = typeof j?.session_id === 'string' && j.session_id ? j.session_id : null;
    return { cost, sessionId };
  } catch (_) {
    return { cost: null, sessionId: null };
  }
}

// One throwaway `claude -p`, wrapped in a login+interactive shell for PATH parity with
// server/digests.js — a hooked started from launchd/systemd otherwise does not find `claude`.
function runPing(model) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    const flag = model && isValidModelArg(model) ? ` --model ${model}` : '';
    const cmd = `claude -p --output-format json${flag}`;
    const child = spawn(shell, ['-l', '-i', '-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish({ ok: false, error: 'claude -p timed out' });
    }, PING_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: 'claude -p failed to start: ' + (e.message || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const { cost, sessionId } = parsePingOutput(out);
      if (code === 0) return finish({ ok: true, cost, sessionId });
      finish({ ok: false, error: `claude -p exited ${code}${err ? ': ' + err.trim().slice(0, 200) : ''}` });
    });
    try { child.stdin.write(PING_PROMPT); child.stdin.end(); } catch (_) {}
  });
}

let inflight = false;

async function tick(now = new Date(), { force = false } = {}) {
  if (inflight) return { act: false, reason: 'a ping is already in flight' };
  const c = cfg();
  const util = currentUtilization(now.getTime());
  const decision = force
    ? { act: true, reason: 'manual run' }
    : warmupDecision(c, now, util, readState());
  if (!decision.act) return decision;
  inflight = true;
  let res;
  try {
    res = await runPing(c && c.model);
  } finally {
    inflight = false;
  }
  // The ping is a throwaway to unlock budget, not a conversation to review — archive it on sight
  // so it doesn't clutter the active list. Best-effort: a write failure here must not lose the
  // ping's own outcome below.
  if (res.ok && res.sessionId) {
    try { setSessionMeta(res.sessionId, { archived: true }); } catch (_) {}
  }
  writeState({
    lastPingAt: now.getTime(),
    lastPingDay: localDay(now),
    lastReason: decision.reason,
    lastResult: res.ok ? 'ok' : 'error',
    lastError: res.ok ? null : res.error,
    lastCost: res.cost ?? null,
    lastSessionId: res.sessionId ?? null,
  });
  return { ...decision, result: res };
}

// ---------- public surface ----------

// The timer runs unconditionally (like the digest one): the config is re-read at every tick, so
// toggling the feature on takes effect live, without a restart. Ticking on wall-clock time rather
// than sleeping until the anchor is deliberate — Node timers are monotonic and do NOT advance
// while a laptop sleeps, so a timer armed at midnight for 06:00 would fire hours late.
function startWarmupScheduler() {
  if (globalThis[TIMER]) return;
  const t = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (typeof t.unref === 'function') t.unref();
  globalThis[TIMER] = t;
  tick().catch(() => {}); // immediate pass: catches up a boot or a wake that missed the anchor
}

// Same entry point, called from /api/settings so the scheduler also runs under `npm run live`,
// where src/hooks.server.js skips its prod-only boot block.
function applyWarmupSetting() {
  startWarmupScheduler();
}

function warmupStatus(now = new Date()) {
  const c = cfg();
  const slots = warmupSlots(c && c.workHours);
  const anchor = slots.length ? anchorFor(c, slots) : null;
  const util = currentUtilization(now.getTime());
  const five = accountLimit('session', util, now.getTime());
  const decision = warmupDecision(c, now, util, readState());
  return {
    enabled: !!(c && c.enabled),
    anchor: anchor == null ? null : fmtHm(anchor),
    windows: warmupPlan(slots, anchor).map((w) => ({
      start: fmtHm(w.start),
      end: fmtHm(w.end),
      workMin: w.work,
    })),
    workMin: slots.reduce((n, [a, b]) => n + (b - a), 0),
    decision: { act: decision.act, reason: decision.reason },
    fiveHour: five ? { pct: five.pct, resetsAt: five.resetsAt, at: hmOf(five.resetsAt) } : null,
    state: readState(),
  };
}

const runWarmupNow = () => tick(new Date(), { force: true });

export {
  startWarmupScheduler,
  applyWarmupSetting,
  warmupStatus,
  runWarmupNow,
  warmupSlots,
  warmupPlan,
  warmupAnchor,
  warmupDecision,
  parsePingOutput,
};
