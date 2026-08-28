/*
 * Remote-control daemon helpers (server/remoteControl.js). Spawning a real daemon needs a real
 * `claude` binary, so that path isn't unit-tested; this covers the pure derivations (project key /
 * app name) and the PID registry (rc-daemons.json) on a throwaway HOOKED_DATA_DIR.
 *
 * Since the move off tmux, the daemons are detached child processes tracked by PID instead of named
 * tmux sessions — so what used to be a "is this a hooked-rc-* tmux name?" check is now a liveness
 * check on a PID, and the hidden-session set lives in events.jsonl (the `rc` flag hook.cjs copies
 * from HOOKED_RC) rather than in its own file. See test/rcHidden.test.mjs for that half.
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
  it('is stable for a given path and distinct for different paths with the same basename', () => {
    expect(rc.rcKey('/a/proj')).toBe(rc.rcKey('/a/proj'));
    expect(rc.rcKey('/a/proj')).not.toBe(rc.rcKey('/b/proj'));
    expect(rc.rcAppName('/a/proj')).not.toBe(rc.rcAppName('/b/proj'));
  });

  it('only interpolation-safe characters end up in the app name', () => {
    // The app name is interpolated into the daemon's shell command (`claude remote-control --name`).
    expect(rc.rcAppName('/Users/x/weird; rm -rf /')).toMatch(/^[A-Za-z0-9_]+$/);
  });

  it('keeps a readable basename in the key', () => {
    expect(rc.rcKey('/Users/x/My Project')).toMatch(/^My_Project-[0-9a-f]{8}$/);
  });
});

describe('pid liveness', () => {
  it('recognizes our own process as alive', () => {
    expect(rc.pidAlive(process.pid)).toBe(true);
  });

  it('rejects garbage and impossible pids', () => {
    for (const bad of [null, undefined, 0, -1, 1.5, 'x']) expect(rc.pidAlive(bad)).toBe(false);
  });
});

describe('pid registry', () => {
  const file = () => path.join(TMP, 'rc-daemons.json');

  it('starts empty', () => {
    expect(rc.runningDaemons()).toEqual({});
  });

  it('reports a daemon whose pid is alive', () => {
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ 'proj-abc': { pid: process.pid, cwd: '/a/proj', app: 'proj_abc' } }));
    expect(Object.keys(rc.runningDaemons())).toEqual(['proj-abc']);
  });

  it('purges dead pids from the file on read (self-healing)', () => {
    // pid 2**31-1 : hors de portée sur tout OS courant → jamais vivant.
    fs.writeFileSync(file(), JSON.stringify({
      alive: { pid: process.pid, cwd: '/a', app: 'a' },
      dead: { pid: 2147483647, cwd: '/b', app: 'b' },
    }));
    expect(Object.keys(rc.runningDaemons())).toEqual(['alive']);
    // le fichier lui-même a été réécrit sans l'entrée morte
    expect(Object.keys(JSON.parse(fs.readFileSync(file(), 'utf8')))).toEqual(['alive']);
  });

  it('treats an unreadable / corrupt file as empty rather than throwing', () => {
    fs.writeFileSync(file(), 'not json at all');
    expect(rc.runningDaemons()).toEqual({});
  });
});
