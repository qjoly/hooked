import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCron, cronMatches, nextRun, nextRuns, validCron } from '../src/lib/cron.js';

const at = (s) => new Date(s); // local time, like the scheduler

describe('parseCron', () => {
  it('expands lists, ranges and steps', () => {
    const c = parseCron('*/15 9-17 * * 1-5');
    expect([...c.minute]).toEqual([0, 15, 30, 45]);
    expect(c.hour.size).toBe(9);
    expect([...c.dow]).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads a start with a step as running to the field max', () => {
    expect([...parseCron('50/5 * * * *').minute]).toEqual([50, 55]);
  });

  it('accepts aliases and 7 as Sunday', () => {
    expect(validCron('@daily')).toBeNull();
    expect([...parseCron('0 0 * * 7').dow]).toEqual([0]);
  });

  it('rejects malformed expressions with a readable message', () => {
    expect(validCron('* * *')).toMatch(/5 fields/);
    expect(validCron('60 * * * *')).toMatch(/minute out of range/);
    expect(validCron('a * * * *')).toMatch(/invalid minute/);
  });
});

describe('cronMatches', () => {
  it('ORs day-of-month and day-of-week when both are set', () => {
    const c = parseCron('0 9 1 * 1');
    expect(cronMatches(c, at('2026-11-02T09:00'))).toBe(true); // a Monday
    expect(cronMatches(c, at('2026-12-01T09:00'))).toBe(true); // the 1st
    expect(cronMatches(c, at('2026-11-03T09:00'))).toBe(false);
  });
});

describe('nextRun', () => {
  it('finds the next weekday slot', () => {
    expect(nextRun(parseCron('0 9 * * 1-5'), at('2026-10-30T10:00')).getTime()).toBe(at('2026-11-02T09:00').getTime());
  });

  it('is strictly after the reference minute', () => {
    expect(nextRun(parseCron('* * * * *'), at('2026-11-01T10:00:30')).getTime()).toBe(at('2026-11-01T10:01').getTime());
  });

  it('returns null for a date that never exists', () => {
    expect(nextRun(parseCron('0 0 30 2 *'), at('2026-01-01T00:00'))).toBeNull();
  });

  it('lists consecutive runs', () => {
    expect(nextRuns('0 */6 * * *', 3, at('2026-11-01T01:00')).map((d) => d.getHours())).toEqual([6, 12, 18]);
  });
});

describe('cron task storage', () => {
  let cron;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-cron-proj-'));
  beforeAll(async () => {
    process.env.HOOKED_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-cron-data-'));
    cron = await import('../server/cron.js');
  });

  it('validates, creates, updates and deletes a task', () => {
    expect(() => cron.saveCronTask({ schedule: 'nope', cwd, prompt: 'x' })).toThrow(/invalid schedule/);
    expect(() => cron.saveCronTask({ schedule: '@daily', cwd: '/does/not/exist', prompt: 'x' })).toThrow(/not a directory/);

    const t = cron.saveCronTask({ schedule: '0 9 * * *', cwd, prompt: 'Summarize open PRs\nthen stop', permissionMode: 'weird' });
    expect(t.id).toMatch(/^[a-z0-9]+$/);
    expect(t.name).toBe('Summarize open PRs');
    expect(t.permissionMode).toBe('default');

    const u = cron.saveCronTask({ ...t, enabled: false, runs: [{ at: 'forged' }] });
    expect(u.enabled).toBe(false);
    expect(u.runs).toEqual([]);
    expect(cron.listCronTasks()[0].nextRun).toBeNull();

    const p = cron.saveCronTask({ id: t.id, schedule: '@hourly' });
    expect(p).toMatchObject({ schedule: '@hourly', prompt: t.prompt, cwd, enabled: false });

    cron.deleteCronTask(t.id);
    expect(cron.readCronTasks()).toEqual([]);
  });
});
