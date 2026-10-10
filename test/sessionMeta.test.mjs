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

let readSessionMeta, writeSessionMeta, setSessionMeta, joinGroup, leaveGroup, setGroupMother, renameGroup, groupMotherOf;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  ({ readSessionMeta, writeSessionMeta, setSessionMeta, joinGroup, leaveGroup, setGroupMother, renameGroup, groupMotherOf } = await import('../server/sessionMeta.js'));
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

  it('marks a session incognito, and clearing it drops the entry', () => {
    const map = setSessionMeta('sess-incog', { incognito: true });
    expect(map['sess-incog']).toEqual({ incognito: true });
    expect(readSessionMeta()['sess-incog']).toEqual({ incognito: true });
    expect(setSessionMeta('sess-incog', { incognito: false })['sess-incog']).toBeUndefined();
  });

  it('keeps the incognito flag alongside the other facts', () => {
    setSessionMeta('sess-incog2', { incognito: true });
    const map = setSessionMeta('sess-incog2', { archived: true });
    expect(map['sess-incog2']).toEqual({ archived: true, incognito: true });
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

describe('session groups', () => {
  const kids = (map, mother) => Object.keys(map).filter((k) => map[k].groupOf === mother)
    .sort((a, b) => map[a].groupAt - map[b].groupAt);

  it('a lone session is its own mother', () => {
    expect(groupMotherOf('g-lone')).toBe('g-lone');
  });

  it('join puts a session under the target mother, in join order', () => {
    joinGroup('g-b', 'g-a');
    const map = joinGroup('g-c', 'g-a');
    expect(kids(map, 'g-a')).toEqual(['g-b', 'g-c']);
    expect(groupMotherOf('g-c')).toBe('g-a');
  });

  it('joining a child resolves to its mother (one level only)', () => {
    const map = joinGroup('g-d', 'g-b');
    expect(map['g-d'].groupOf).toBe('g-a');
  });

  it('joining a mother merges its whole group', () => {
    joinGroup('g-y', 'g-x');
    const map = joinGroup('g-x', 'g-a');
    expect(map['g-x'].groupOf).toBe('g-a');
    expect(map['g-y'].groupOf).toBe('g-a');
  });

  it('keeps other facts on a session that joins a group', () => {
    setSessionMeta('g-arch', { archived: true });
    const map = joinGroup('g-arch', 'g-a');
    expect(map['g-arch']).toMatchObject({ archived: true, groupOf: 'g-a' });
    expect(setSessionMeta('g-arch', { archived: false })['g-arch'].groupOf).toBe('g-a');
    leaveGroup('g-arch');
  });

  it('rename stores the name on the mother, even when addressed through a child', () => {
    const map = renameGroup('g-b', '  Auth refactor  ');
    expect(map['g-a'].groupName).toBe('Auth refactor');
    expect(renameGroup('g-a', '')['g-a']?.groupName).toBeUndefined();
    renameGroup('g-a', 'Auth refactor');
  });

  it('setGroupMother swaps roles and moves the name', () => {
    const map = setGroupMother('g-c');
    expect(map['g-c'].groupOf).toBeUndefined();
    expect(map['g-c'].groupName).toBe('Auth refactor');
    expect(map['g-a'].groupOf).toBe('g-c');
    expect(kids(map, 'g-c')[0]).toBe('g-a'); // the former mother becomes the first child
    expect(map['g-b'].groupOf).toBe('g-c');
  });

  it('a child leaving becomes a lone session', () => {
    const map = leaveGroup('g-d');
    expect(map['g-d']).toBeUndefined();
  });

  it('the mother leaving promotes the oldest child', () => {
    const map = leaveGroup('g-c');
    expect(map['g-c']).toBeUndefined();
    expect(map['g-a'].groupOf).toBeUndefined();
    expect(map['g-a'].groupName).toBe('Auth refactor');
    expect(map['g-b'].groupOf).toBe('g-a');
  });

  it('flattens chains and drops cycles on read', () => {
    const map = writeSessionMeta({
      c1: { groupOf: 'c2', groupAt: 1 }, c2: { groupOf: 'c3', groupAt: 2 },
      l1: { groupOf: 'l2' }, l2: { groupOf: 'l1' }, self: { groupOf: 'self' },
    });
    expect(map.c1.groupOf).toBe('c3');
    expect(map.l1).toBeUndefined();
    expect(map.l2).toBeUndefined();
    expect(map.self).toBeUndefined();
  });
});
