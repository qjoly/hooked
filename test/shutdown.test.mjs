/*
 * Graceful shutdown (server/shutdown.js).
 *
 * The bug this pins: `adapter-node` handles SIGINT itself, closes the HTTP listener and never calls
 * `process.exit`, so the process only leaves when the event loop drains. Any handle nobody released
 * — the SSE fs watchers, a driven session's subprocess, a PTY — kept hooked alive with a dead
 * dashboard, and Ctrl+C looked like it did nothing.
 *
 * `shutdownNow` is the release path and it is callable without a live session: what is tested here
 * is that it runs every registered callback, that unregistering works, that it survives a callback
 * that throws, and that installing the signal handler twice installs one.
 *
 * The data dir is a throwaway one (same idiom as mcpLaunchConfig): the release path writes the
 * driven-sessions snapshot, and the default dir would be the shared fixtures.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'hooked-shutdown-' + process.pid);
process.env.HOOKED_DATA_DIR = TMP;
process.env.HOOKED_PROJECTS_DIR = path.join(TMP, 'projects');

let installShutdownHook, onShutdown, shutdownNow;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(process.env.HOOKED_PROJECTS_DIR, { recursive: true });
  ({ installShutdownHook, onShutdown, shutdownNow } = await import('../server/shutdown.js'));
});

// exitGraceMs: 0 — the real default arms a timer that would take the test runner down with it.
const run = () => shutdownNow({ exitGraceMs: 0 });

describe('shutdownNow', () => {
  it('runs registered callbacks and counts them', () => {
    const calls = [];
    const off1 = onShutdown(() => calls.push('a'));
    const off2 = onShutdown(() => calls.push('b'));
    const freed = run();
    expect(calls).toEqual(['a', 'b']);
    expect(freed.hooks).toBe(2);
    off1(); off2();
  });

  it('stops running a callback that unregistered', () => {
    const calls = [];
    const off = onShutdown(() => calls.push('a'));
    off();
    run();
    expect(calls).toEqual([]);
  });

  it('keeps going when a callback throws', () => {
    const calls = [];
    const off1 = onShutdown(() => { throw new Error('boom'); });
    const off2 = onShutdown(() => calls.push('after'));
    expect(() => run()).not.toThrow();
    expect(calls).toEqual(['after']); // the throwing one must not swallow the next
    off1(); off2();
  });

  it('ignores anything that is not a function', () => {
    expect(() => onShutdown(null)).not.toThrow();
    expect(run().hooks).toBe(0);
  });
});

describe('installShutdownHook', () => {
  it('installs a single handler however many times it is called', () => {
    const before = process.listenerCount('SIGINT');
    const first = installShutdownHook();
    const second = installShutdownHook();
    expect(second).toBe(false); // idempotent: the second call is a no-op
    expect(process.listenerCount('SIGINT')).toBe(before + (first ? 1 : 0));
  });
});
