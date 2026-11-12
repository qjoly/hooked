/*
 * Auto-pull of main checkouts (server/autoPull.js) against a local bare "remote": no network.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.realpathSync(os.tmpdir()) + '/hooked-autopull-test-' + process.pid;
const ORIGIN = path.join(TMP, 'origin.git');
const OTHER = path.join(TMP, 'other');
process.env.HOOKED_DATA_DIR = path.join(TMP, 'data');
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
});

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let n = 0;
let pushes = 0;
const clone = () => { const dir = path.join(TMP, 'c' + ++n); execFileSync('git', ['clone', '-q', ORIGIN, dir]); return dir; };
const pushUpstream = (file = `push-${++pushes}.txt`) => {
  fs.writeFileSync(path.join(OTHER, file), file);
  git(OTHER, 'add', '.');
  git(OTHER, 'commit', '-qm', file);
  git(OTHER, 'push', '-q', 'origin', 'main');
};

let ap;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(process.env.HOOKED_DATA_DIR, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', ORIGIN]);
  execFileSync('git', ['clone', '-q', ORIGIN, OTHER]);
  git(OTHER, 'checkout', '-q', '-b', 'main');
  pushUpstream('init.txt');
  ap = await import('../server/autoPull.js');
});

describe('pullCheckout', () => {
  it('fast-forwards a clean default-branch checkout', async () => {
    const dir = clone();
    pushUpstream();
    pushUpstream();
    expect(await ap.pullCheckout(dir)).toEqual({ path: dir, branch: 'main', result: 'pulled', commits: 2 });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(OTHER, 'rev-parse', 'HEAD'));
    expect(await ap.pullCheckout(dir)).toMatchObject({ result: 'up to date' });
  });

  it('leaves local work alone', async () => {
    const dirty = clone();
    fs.writeFileSync(path.join(dirty, 'untracked.txt'), 'u');
    const ahead = clone();
    fs.writeFileSync(path.join(ahead, 'mine.txt'), 'm');
    git(ahead, 'add', '.');
    git(ahead, 'commit', '-qm', 'mine');
    pushUpstream();
    expect(await ap.pullCheckout(dirty)).toMatchObject({ result: 'skipped', why: 'local changes' });
    expect(await ap.pullCheckout(ahead)).toMatchObject({ result: 'skipped', why: 'local commits' });
  });

  it('skips another branch, a branch without upstream, and a checkout with a running session', async () => {
    const feature = clone();
    git(feature, 'checkout', '-q', '-b', 'feat/x', '--track', 'origin/main');
    const local = clone();
    git(local, 'checkout', '-q', '-b', 'scratch');
    const busy = clone();
    expect(await ap.pullCheckout(feature)).toMatchObject({ result: 'skipped', why: 'not on the default branch' });
    expect(await ap.pullCheckout(local)).toMatchObject({ result: 'skipped', why: 'no upstream' });
    expect(await ap.pullCheckout(busy, { liveCwds: [path.join(busy, 'src')] })).toMatchObject({ result: 'skipped', why: 'a session is running in it' });
  });

  it('does not count a session in a linked worktree as running in the main checkout', async () => {
    const dir = clone();
    const linked = path.join(dir, '.claude', 'worktrees', 'w');
    git(dir, 'worktree', 'add', '-q', '-b', 'feat/linked', linked);
    pushUpstream();
    expect(await ap.pullCheckout(dir, { liveCwds: [linked] })).toMatchObject({ result: 'skipped', why: 'local changes' });
    fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '.claude/\n');
    expect(await ap.pullCheckout(dir, { liveCwds: [linked] })).toMatchObject({ result: 'pulled' });
  });
});

describe('autoPullRoots', () => {
  it('maps recent sessions to their main checkouts', () => {
    const dir = clone();
    const linked = path.join(TMP, 'linked-' + n);
    git(dir, 'worktree', 'add', '-q', '-b', 'feat/roots', linked);
    fs.mkdirSync(path.join(dir, 'sub'));
    const now = Date.now();
    const recent = new Date(now - 86_400_000).toISOString();
    const sessions = [
      { project: path.join(dir, 'sub'), lastTs: recent },
      { project: linked, lastTs: recent },
      { project: OTHER, lastTs: new Date(now - 60 * 86_400_000).toISOString() },
      { project: TMP, lastTs: recent },
      { project: null, lastTs: recent },
    ];
    expect(ap.autoPullRoots(sessions, now)).toEqual([dir]);
  });
});
