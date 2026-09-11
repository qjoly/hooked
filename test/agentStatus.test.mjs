/*
 * Status snapshots for driven sessions (server/agent-status.js). An Agent SDK session has no TUI,
 * hence no statusline, hence no file from `statusline-tap.sh`: we query the Query and write it
 * ourselves, IN THE SAME FORMAT. So what matters here:
 *   1. the conversion from SDK payloads to the statusline shape (pure);
 *   2. that `server/status.js` reads back what we wrote (the contract between the two).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot, writeSnapshot } from '../server/agent-status.js';
import { sessionStatus } from '../server/status.js';

const NOW = Date.parse('2026-09-11T10:00:00Z');
const ID = '19389552-2f0b-420f-80c8-300d69b7f3f8';

// Real shape of `getContextUsage()` (SDKControlGetContextUsageResponse), trimmed to what we read.
const CTX = { totalTokens: 91_000, maxTokens: 176_000, rawMaxTokens: 200_000, percentage: 45, categories: [] };
// Real shape of `usage_EXPERIMENTAL_…()` (SDKControlGetUsageResponse), same.
const USAGE = {
  session: { total_cost_usd: 1.23, model_usage: {} },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 42, resets_at: '2026-09-11T11:50:00Z' },
    seven_day: { utilization: 58.4, resets_at: '2026-09-15T12:00:00Z' },
  },
};

describe('buildSnapshot', () => {
  it('converts context and rate limits to the statusline format (resets in seconds)', () => {
    expect(buildSnapshot(ID, { ctx: CTX, usage: USAGE, model: 'opus', effort: 'high' }, NOW)).toEqual({
      session_id: ID,
      source: 'sdk',
      ts: NOW / 1000,
      model: { id: 'opus', display_name: 'opus' },
      effort: { level: 'high' },
      context_window: { used_percentage: 45, context_window_size: 200_000 },
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: Date.parse('2026-09-11T11:50:00Z') / 1000 },
        seven_day: { used_percentage: 58.4, resets_at: Date.parse('2026-09-15T12:00:00Z') / 1000 },
      },
    });
  });

  it('writes no rate limits when the account has none (API key, Bedrock…)', () => {
    const snap = buildSnapshot(ID, {
      ctx: CTX,
      usage: { rate_limits_available: false, rate_limits: null },
    }, NOW);
    expect(snap.rate_limits).toBeUndefined();
    expect(snap.context_window.used_percentage).toBe(45);
  });

  it('returns null when both control requests failed (nothing to overwrite)', () => {
    expect(buildSnapshot(ID, { ctx: null, usage: null }, NOW)).toBe(null);
    expect(buildSnapshot(null, { ctx: CTX }, NOW)).toBe(null);
  });
});

describe('writeSnapshot → status.js', () => {
  it('writes a file sessionStatus reads back as-is', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-status-'));
    const snap = buildSnapshot(ID, { ctx: CTX, usage: USAGE, model: 'opus', effort: 'high' }, NOW);
    expect(writeSnapshot(snap, dir)).toBe(true);
    const st = sessionStatus(ID, dir, NOW);
    expect(st.effort).toBe('high');
    expect(st.context).toEqual({ pct: 45, size: 200_000 });
    expect(st.rateLimit.fiveHour).toEqual({
      pct: 42,
      resetsAt: Date.parse('2026-09-11T11:50:00Z'),
      resetInMin: 110,
    });
    expect(st.rateLimit.sevenDay.pct).toBe(58);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a dubious id (path traversal)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-status-'));
    expect(writeSnapshot({ session_id: '../escape' }, dir)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
