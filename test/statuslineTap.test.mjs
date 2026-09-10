/*
 * Characterisation tests for statusline-tap.sh.
 *
 * The tap runs on every statusline render of every session, wrapping whatever command the user
 * already had in `statusLine` (moved into HOOKED_SL by install.cjs). Two things must hold and
 * neither is covered anywhere else: it stays transparent for that wrapped command, and it stays
 * cheap in spawned processes, because on macOS an EDR sensor bills each process creation.
 *
 * The spawn budget is pinned with PATH shims that log every call, `cat` included, so a future
 * rewrite that reintroduces a `cat`, a second `jq`, a `mkdir` or an intermediate shell fails here
 * instead of quietly costing a process on every render of every session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'statusline-tap.sh');
const SHIMMED = ['jq', 'mkdir', 'sh', 'cat'];

let home;      // fake HOME, so the tap writes into the tmpdir
let binDir;    // PATH shims
let spawnLog;

/** Resolve a tool the shim must delegate to, before PATH is rewritten. */
const realPath = (tool) => execFileSync('/usr/bin/env', ['sh', '-c', `command -v ${tool}`]).toString().trim();

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-tap-'));
  home = path.join(root, 'home');
  binDir = path.join(root, 'bin');
  spawnLog = path.join(root, 'spawns.log');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  for (const tool of SHIMMED) {
    const shim = path.join(binDir, tool);
    fs.writeFileSync(shim, `#!/bin/sh\necho ${tool} >> "${spawnLog}"\nexec ${realPath(tool)} "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
});

afterEach(() => {
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
});

const statusDir = () => path.join(home, '.claude', 'hooked', 'status');

/** Run the tap on `payload`, returning its stdout, exit code and the processes it spawned. */
function render(payload, { sl } = {}) {
  const env = { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH}` };
  if (sl === undefined) delete env.HOOKED_SL; else env.HOOKED_SL = sl;
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync('bash', [TAP], { input: payload, env, encoding: 'utf8' });
  } catch (e) {
    stdout = e.stdout ?? '';
    code = e.status;
  }
  const spawns = fs.existsSync(spawnLog)
    ? fs.readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean)
    : [];
  return { stdout, code, spawns };
}

const payload = (over = {}) => JSON.stringify({
  session_id: 'sid-1',
  model: { display_name: 'Opus 5' },
  effort: { level: 'high' },
  rate_limits: { five_hour: { used_percentage: 27 } },
  context_window: { used_percentage: 12 },
  fast_mode: false,
  thinking: { enabled: true },
  ...over,
});

describe('the status file', () => {
  it('carries the fields the dashboard reads, plus a timestamp', () => {
    const before = Date.now() / 1000;
    render(payload(), { sl: 'cat' });
    const written = JSON.parse(fs.readFileSync(path.join(statusDir(), 'sid-1.json'), 'utf8'));
    expect(written.session_id).toBe('sid-1');
    expect(written.model).toEqual({ display_name: 'Opus 5' });
    expect(written.rate_limits.five_hour.used_percentage).toBe(27);
    expect(written.context_window.used_percentage).toBe(12);
    expect(written.thinking).toEqual({ enabled: true });
    expect(written.ts).toBeGreaterThanOrEqual(Math.floor(before));
  });

  it('is created even when the status directory does not exist yet', () => {
    expect(fs.existsSync(statusDir())).toBe(false);
    render(payload(), { sl: 'cat' });
    expect(fs.existsSync(path.join(statusDir(), 'sid-1.json'))).toBe(true);
  });

  it('is overwritten in place rather than accumulating', () => {
    render(payload(), { sl: 'cat' });
    render(payload(), { sl: 'cat' });
    expect(fs.readdirSync(statusDir())).toEqual(['sid-1.json']);
  });
});

describe('a payload the tap refuses to trust', () => {
  // The id lands in a file path, so anything outside [A-Za-z0-9._-] is dropped whole rather
  // than sanitised: a partial match would write to an id nobody asked for.
  it.each([
    ['an id holding a path separator', payload({ session_id: 'bad/id' })],
    ['an id holding a traversal', payload({ session_id: '../escape' })],
    ['no session_id at all', JSON.stringify({ model: {} })],
    ['a body that is not JSON', 'not json'],
  ])('writes nothing for %s, and still renders the statusline', (_label, body) => {
    const { stdout, code } = render(body, { sl: 'printf RENDERED' });
    expect(code).toBe(0);
    expect(stdout).toBe('RENDERED');
    expect(fs.existsSync(statusDir()) ? fs.readdirSync(statusDir()) : []).toEqual([]);
  });
});

describe('the wrapped statusline command', () => {
  it('receives the payload on stdin and owns the whole output', () => {
    const body = payload();
    const { stdout } = render(body, { sl: 'cat' });
    // The here-string appends a newline that the old `printf '%s' | sh -c` did not.
    expect(stdout.trimEnd()).toBe(body);
  });

  it('keeps its shell parsing, so a pipeline or quoted arguments still work', () => {
    const { stdout } = render(payload(), { sl: 'jq -r ".model.display_name" | tr "[:lower:]" "[:upper:]"' });
    expect(stdout.trim()).toBe('OPUS 5');
  });

  it('is optional: with no HOOKED_SL the tap renders nothing and still taps', () => {
    const { stdout, code } = render(payload());
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(fs.existsSync(path.join(statusDir(), 'sid-1.json'))).toBe(true);
  });
});

describe('a payload that parses as far as the id but no further', () => {
  // The regex only reads the id, so jq is now the first thing that sees whether the body is
  // valid JSON. Writing through a redirection would empty the previous snapshot before jq got
  // to refuse it.
  it('leaves the previous snapshot untouched', () => {
    render(payload(), { sl: 'true' });
    const file = path.join(statusDir(), 'sid-1.json');
    const good = fs.readFileSync(file, 'utf8');
    expect(good.length).toBeGreaterThan(0);

    const { code } = render('{"session_id":"sid-1"', { sl: 'true' });
    expect(code).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(good);
  });

  it('does not create a snapshot when there was none', () => {
    render('{"session_id":"sid-1"', { sl: 'true' });
    expect(fs.existsSync(statusDir()) ? fs.readdirSync(statusDir()) : []).toEqual([]);
  });
});

describe('the spawn budget', () => {
  // HOOKED_SL is `true`, a shell builtin, so the log holds the tap's own children only and
  // nothing the wrapped command spent on its own behalf.
  it('spends one jq and nothing else once the status directory exists', () => {
    fs.mkdirSync(statusDir(), { recursive: true });
    const { spawns } = render(payload(), { sl: 'true' });
    expect(spawns).toEqual(['jq']);
  });

  it('slurps stdin with a builtin rather than spending a cat', () => {
    fs.mkdirSync(statusDir(), { recursive: true });
    const { spawns } = render(payload(), { sl: 'true' });
    expect(spawns).not.toContain('cat');
  });

  it('spends one extra mkdir only on the very first render', () => {
    const first = render(payload(), { sl: 'true' });
    expect(first.spawns.filter((s) => s === 'mkdir')).toHaveLength(1);
    fs.writeFileSync(spawnLog, '');
    const second = render(payload(), { sl: 'true' });
    expect(second.spawns).not.toContain('mkdir');
  });

  it('spawns no intermediate shell to run HOOKED_SL', () => {
    fs.mkdirSync(statusDir(), { recursive: true });
    const { spawns } = render(payload(), { sl: 'true' });
    expect(spawns).not.toContain('sh');
  });
});
