/*
 * Server-side per-session Deck metadata (server/sessionMeta.js) — round-trips through
 * readSessionMeta / writeSessionMeta / setSessionMeta on a throwaway HOOKED_DATA_DIR.
 * Archived + snooze moved from per-browser localStorage to a shared server store.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'hooked-session-meta-test-' + process.pid);
process.env.HOOKED_DATA_DIR = TMP;

let readSessionMeta, writeSessionMeta, setSessionMeta;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  ({ readSessionMeta, writeSessionMeta, setSessionMeta } = await import('../server/sessionMeta.js'));
});

const inOneHour = () => Date.now() + 3600_000;

describe('readSessionMeta', () => {
  it('defaults to an empty map when no file exists', () => {
    expect(readSessionMeta()).toEqual({});
  });
});

describe('setSessionMeta', () => {
  it('archives a session and persists it', () => {
    const map = setSessionMeta('sess-1', { archived: true });
    expect(map['sess-1']).toEqual({ archived: true });
    expect(readSessionMeta()['sess-1']).toEqual({ archived: true });
  });

  it('unarchiving removes the entry when nothing else remains', () => {
    setSessionMeta('sess-2', { archived: true });
    const map = setSessionMeta('sess-2', { archived: false });
    expect(map['sess-2']).toBeUndefined();
    expect(readSessionMeta()['sess-2']).toBeUndefined();
  });

  it('stores a future snooze and merges with an archived flag', () => {
    const until = inOneHour();
    setSessionMeta('sess-3', { archived: true });
    const map = setSessionMeta('sess-3', { snoozeUntil: until });
    expect(map['sess-3']).toEqual({ archived: true, snoozeUntil: until });
  });

  it('clearing the snooze (null) keeps the other facts', () => {
    const until = inOneHour();
    setSessionMeta('sess-4', { archived: true, snoozeUntil: until });
    const map = setSessionMeta('sess-4', { snoozeUntil: null });
    expect(map['sess-4']).toEqual({ archived: true });
  });

  it('drops an expired or invalid snooze', () => {
    expect(setSessionMeta('sess-5', { snoozeUntil: Date.now() - 1000 })['sess-5']).toBeUndefined();
    expect(setSessionMeta('sess-6', { snoozeUntil: 'tomorrow' })['sess-6']).toBeUndefined();
  });

  it('caps a snooze pushed absurdly far in the future (30 days)', () => {
    const until = Date.now() + 365 * 24 * 3600_000;
    const map = setSessionMeta('sess-7', { snoozeUntil: until });
    expect(map['sess-7'].snoozeUntil).toBeLessThanOrEqual(Date.now() + 30 * 24 * 3600_000);
    expect(map['sess-7'].snoozeUntil).toBeGreaterThan(Date.now());
  });

  it('rejects a non-string id', () => {
    expect(() => setSessionMeta(42, { archived: true })).toThrow();
  });
});

describe('writeSessionMeta', () => {
  it('sanitizes the whole map: drops empty/expired entries, keeps real facts', () => {
    const until = inOneHour();
    const map = writeSessionMeta({
      a: { archived: true },
      b: { archived: false },
      c: { snoozeUntil: Date.now() - 1 },
      d: { snoozeUntil: until, junk: 'x' },
      e: 'nope',
    });
    expect(map).toEqual({ a: { archived: true }, d: { snoozeUntil: until } });
    expect(readSessionMeta()).toEqual({ a: { archived: true }, d: { snoozeUntil: until } });
  });

  it('ignores non-object input', () => {
    expect(writeSessionMeta(null)).toEqual({});
    expect(writeSessionMeta('nope')).toEqual({});
  });
});

describe('readSessionMeta (expiry)', () => {
  it('prunes a snooze that expired since it was written', () => {
    // Write a raw file with an expired snooze, bypassing sanitize.
    const file = path.join(TMP, 'session-meta.json');
    fs.writeFileSync(file, JSON.stringify({ z: { snoozeUntil: Date.now() - 5000 } }));
    expect(readSessionMeta().z).toBeUndefined();
  });
});
