import { describe, it, expect } from 'vitest';
import { warmupSlots, warmupPlan, warmupAnchor, warmupDecision, parsePingOutput } from '../server/warmup.js';

const DAY = [['09:00', '12:00'], ['14:00', '18:00']];
const SLOTS = warmupSlots(DAY);
const hm = (h, m = 0) => h * 60 + m;

// A Tuesday, so getDay() === 2 and the default working days apply.
const at = (h, m = 0) => new Date(2026, 8, 15, h, m, 0, 0);
const util = (kind, pct, resetsAt) => ({
  limits: [{ kind, percent: pct, scope: null, resets_at: new Date(resetsAt).toISOString() }],
});
const CFG = {
  enabled: true, mode: 'auto', at: '06:00', days: [1, 2, 3, 4, 5],
  workHours: DAY, model: 'haiku', skipIfWeeklyOver: 90,
};

describe('warmupSlots', () => {
  it('parses, sorts and merges, dropping malformed entries', () => {
    expect(SLOTS).toEqual([[540, 720], [840, 1080]]);
    expect(warmupSlots([['14:00', '18:00'], ['09:00', '12:00']])).toEqual([[540, 720], [840, 1080]]);
    expect(warmupSlots([['09:00', '13:00'], ['12:00', '18:00']])).toEqual([[540, 1080]]);
    expect(warmupSlots([['nope', '12:00'], ['12:00', '09:00'], ['25:00', '26:00'], 'x'])).toEqual([]);
  });
});

describe('warmupAnchor', () => {
  it('lands on 06:00 for a 09:00-12:00 / 14:00-18:00 day', () => {
    expect(warmupAnchor(SLOTS)).toBe(hm(6));
  });

  it('is the unique maximin optimum — no anchor beats it on (window count, smallest share)', () => {
    const best = warmupPlan(SLOTS, hm(6));
    const bestKey = [best.length, Math.min(...best.map((w) => w.work))];
    for (let a = hm(4); a <= hm(9); a += 5) {
      const w = warmupPlan(SLOTS, a);
      const key = [w.length, w.length ? Math.min(...w.map((x) => x.work)) : 0];
      const better = key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1]);
      expect(better, `anchor ${a} should not beat 06:00`).toBe(false);
    }
  });

  it('splits the day 2h / 3h / 2h', () => {
    expect(warmupPlan(SLOTS, hm(6))).toEqual([
      { start: hm(6), end: hm(11), work: 120 },
      { start: hm(11), end: hm(16), work: 180 },
      { start: hm(16), end: hm(21), work: 120 },
    ]);
  });

  it('keeps the middle window at a constant 3h of work whatever the anchor', () => {
    // The algebra the anchor choice rests on: only the first and last shares move, so maximising
    // the smallest one is the whole decision.
    for (let a = hm(4, 5); a <= hm(7); a += 5) {
      const w = warmupPlan(SLOTS, a);
      expect(w.length).toBe(3);
      expect(w[1].work).toBe(180);
      expect(w[0].work + w[2].work).toBe(240);
    }
  });

  it('gives up the third window once the anchor is too late to fit two boundaries', () => {
    expect(warmupPlan(SLOTS, hm(9)).length).toBe(2);
    expect(warmupPlan(SLOTS, hm(8)).length).toBe(2);
  });

  it('handles an unbroken day and a single short slot', () => {
    expect(warmupAnchor(warmupSlots([['09:00', '18:00']]))).not.toBeNull();
    expect(warmupPlan(warmupSlots([['09:00', '10:00']]), hm(6))).toEqual([
      { start: hm(6), end: hm(11), work: 60 },
    ]);
    expect(warmupAnchor([])).toBeNull();
  });
});

describe('warmupDecision', () => {
  const closed = at(6, 0).getTime() - 3600_000; // a window that expired an hour ago

  it('pings at the anchor when the window is closed', () => {
    const d = warmupDecision(CFG, at(6, 0), util('session', 0, closed), {});
    expect(d.act).toBe(true);
  });

  it('holds before the anchor, and after the working day', () => {
    expect(warmupDecision(CFG, at(5, 30), util('session', 0, closed), {}).act).toBe(false);
    expect(warmupDecision(CFG, at(18, 30), util('session', 0, closed), {}).act).toBe(false);
  });

  it('stays out of the way while a window is already open', () => {
    const open = util('session', 4, at(14, 10).getTime());
    const d = warmupDecision(CFG, at(9, 30), open, {});
    expect(d.act).toBe(false);
    expect(d.reason).toMatch(/already open until 14:10/);
  });

  it('reopens a window mid-day — a boundary falling during a break is not lost', () => {
    const d = warmupDecision(CFG, at(12, 15), util('session', 0, at(12, 10).getTime()), {});
    expect(d.act).toBe(true);
  });

  it('respects the weekly guard: more 5h windows is a trap when the 7d budget is nearly gone', () => {
    const u = { limits: [...util('session', 0, closed).limits, ...util('weekly_all', 93, closed).limits] };
    const d = warmupDecision(CFG, at(6, 0), u, {});
    expect(d.act).toBe(false);
    expect(d.reason).toMatch(/weekly budget at 93%/);
  });

  it('never fires twice in a row, whatever the usage data says', () => {
    const state = { lastPingAt: at(6, 0).getTime() - 60_000 };
    expect(warmupDecision(CFG, at(6, 0), util('session', 0, closed), state).act).toBe(false);
  });

  it('falls back to one ping a day when there is no usage payload at all', () => {
    expect(warmupDecision(CFG, at(6, 0), null, {}).act).toBe(true);
    expect(warmupDecision(CFG, at(9, 0), null, { lastPingDay: '2026-09-15' }).act).toBe(false);
  });

  it('is off when disabled, on a non-working day, or with no hours set', () => {
    expect(warmupDecision({ ...CFG, enabled: false }, at(6, 0), null, {}).act).toBe(false);
    expect(warmupDecision({ ...CFG, days: [1, 3, 4, 5] }, at(6, 0), null, {}).reason).toMatch(/Tuesday/);
    expect(warmupDecision({ ...CFG, workHours: [] }, at(6, 0), null, {}).act).toBe(false);
  });

  it('honours a fixed anchor when the mode asks for one', () => {
    const fixed = { ...CFG, mode: 'fixed', at: '07:30' };
    expect(warmupDecision(fixed, at(6, 0), util('session', 0, closed), {}).act).toBe(false);
    expect(warmupDecision(fixed, at(7, 30), util('session', 0, closed), {}).act).toBe(true);
  });
});

describe('parsePingOutput', () => {
  it('reads cost and session_id off the SDKResultMessage envelope', () => {
    const stdout = JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.0012, session_id: 'abc-123', result: 'ok' });
    expect(parsePingOutput(stdout)).toEqual({ cost: 0.0012, sessionId: 'abc-123' });
  });

  it('is tolerant of a login-shell preamble before the JSON (zoxide/p10k/nvm under launchd)', () => {
    const stdout = 'zoxide: some noise\n' + JSON.stringify({ total_cost_usd: 0.002, session_id: 'xyz' });
    expect(parsePingOutput(stdout)).toEqual({ cost: 0.002, sessionId: 'xyz' });
  });

  it('falls back to nulls on malformed or empty output', () => {
    expect(parsePingOutput('')).toEqual({ cost: null, sessionId: null });
    expect(parsePingOutput('not json')).toEqual({ cost: null, sessionId: null });
    expect(parsePingOutput(JSON.stringify({ total_cost_usd: 'nope' }))).toEqual({ cost: null, sessionId: null });
  });
});
