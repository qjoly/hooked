/*
 * Remote-control daemon helpers (server/remoteControl.js). The tmux reconcile/spawn paths need a
 * live tmux and aren't unit-tested here; this covers the pure derivations (names, prefix check) and
 * the persistent hidden-session set (rc-sessions.json) on a throwaway HOOKED_DATA_DIR.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'hooked-rc-test-' + process.pid);
process.env.HOOKED_DATA_DIR = TMP;

let rc;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  rc = await import('../server/remoteControl.js');
});

describe('names', () => {
  it('derives a hooked-rc-prefixed tmux name from the project path', () => {
    const name = rc.rcTmuxName('/Users/x/My Project');
    expect(name.startsWith('hooked-rc-')).toBe(true);
    expect(rc.isRcTmuxName(name)).toBe(true);
  });

  it('is stable for a given path and distinct for different paths with the same basename', () => {
    expect(rc.rcTmuxName('/a/proj')).toBe(rc.rcTmuxName('/a/proj'));
    expect(rc.rcTmuxName('/a/proj')).not.toBe(rc.rcTmuxName('/b/proj'));
    expect(rc.rcAppName('/a/proj')).not.toBe(rc.rcAppName('/b/proj'));
  });

  it('only interpolation-safe characters end up in the app name', () => {
    expect(rc.rcAppName('/Users/x/weird; rm -rf /')).toMatch(/^[A-Za-z0-9_]+$/);
  });

  it('isRcTmuxName rejects non-daemon names and non-strings', () => {
    expect(rc.isRcTmuxName('hooked-proj-abcde')).toBe(false);
    expect(rc.isRcTmuxName(null)).toBe(false);
    expect(rc.isRcTmuxName(undefined)).toBe(false);
  });
});

describe('hidden session set', () => {
  it('starts empty', () => {
    expect([...rc.rcSessionIdSet()]).toEqual([]);
  });

  it('marks and persists ids idempotently', () => {
    rc.markRcSession('sess-1');
    rc.markRcSession('sess-1'); // dupe → no-op
    rc.markRcSession('sess-2');
    rc.markRcSession('');       // ignored
    expect([...rc.rcSessionIdSet()].sort()).toEqual(['sess-1', 'sess-2']);
  });

  it('survives a re-read from disk', () => {
    expect(rc.rcSessionIdSet().has('sess-1')).toBe(true);
  });
});
