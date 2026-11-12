/*
 * Keeps the main checkout of each recently used repository on its default branch up to date
 * (settings → autoPullProjects). Fast-forward only, and only on a checkout with nothing local:
 * no changed or untracked file, no commit beyond its upstream. Design after T3 Code's
 * "Automatically pull" (MIT, pingdotgg/t3code).
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readSettings } from './settings.js';
import { scanSessions } from './transcript.js';
import { findGitConfig, worktreeOf } from './git.js';
import { isInsidePath } from './worktrees.js';

const TICK_MS = 10 * 60_000;
const FIRST_TICK_MS = 60_000;
const RECENT_MS = 30 * 86_400_000;
const FETCH_TIMEOUT = 120_000;
const GIT_TIMEOUT = 30_000;

function git(cwd, args, timeout = GIT_TIMEOUT) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}

function mainCheckoutOf(cwd) {
  const main = worktreeOf(cwd);
  if (main) return main;
  const cfg = findGitConfig(cwd);
  return cfg && path.basename(path.dirname(cfg)) === '.git' ? path.dirname(path.dirname(cfg)) : null;
}

function autoPullRoots(sessions, now = Date.now()) {
  const roots = new Set();
  for (const s of sessions) {
    if (!s.project || !(now - (Date.parse(s.lastTs) || 0) < RECENT_MS)) continue;
    const root = mainCheckoutOf(s.project);
    if (root) roots.add(root);
  }
  return [...roots].sort();
}

async function isDefaultBranch(root, remote, branch, upstream) {
  const head = await git(root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
  const def = head.ok && head.out ? head.out : null;
  return def ? def === upstream && def === `${remote}/${branch}` : ['main', 'master'].includes(branch);
}

async function pullCheckout(root, { liveCwds = [] } = {}) {
  const skip = (why) => ({ path: root, result: 'skipped', why });
  if (liveCwds.some((c) => c && !worktreeOf(c) && isInsidePath(c, root))) return skip('a session is running in it');
  const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch.ok || !branch.out) return skip('detached HEAD');
  const remote = await git(root, ['config', `branch.${branch.out}.remote`]);
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!remote.ok || remote.out === '.' || !upstream.ok || !upstream.out) return { ...skip('no upstream'), branch: branch.out };
  if (!(await isDefaultBranch(root, remote.out, branch.out, upstream.out))) return { ...skip('not on the default branch'), branch: branch.out };
  const status = await git(root, ['status', '--porcelain']);
  if (!status.ok) return { ...skip('git status failed'), branch: branch.out };
  if (status.out) return { ...skip('local changes'), branch: branch.out };
  const fetch = await git(root, ['fetch', '--quiet', remote.out], FETCH_TIMEOUT);
  if (!fetch.ok) return { path: root, branch: branch.out, result: 'failed', why: 'fetch: ' + fetch.err.split('\n').pop() };
  const counts = await git(root, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
  const [behind, ahead] = counts.out.split(/\s+/).map((n) => parseInt(n, 10) || 0);
  if (ahead) return { ...skip('local commits'), branch: branch.out };
  if (!behind) return { path: root, branch: branch.out, result: 'up to date' };
  const ff = await git(root, ['merge', '--ff-only', '--quiet', '@{u}']);
  if (!ff.ok) return { path: root, branch: branch.out, result: 'failed', why: ff.err.split('\n').pop() };
  return { path: root, branch: branch.out, result: 'pulled', commits: behind };
}

async function runAutoPull({ sessions, liveCwds, now = Date.now() } = {}) {
  sessions ??= scanSessions();
  liveCwds ??= (await import('./agent.js')).liveSessionCwds();
  const roots = autoPullRoots(sessions, now);
  const checkouts = [];
  for (const root of roots) checkouts.push(await pullCheckout(root, { liveCwds }));
  return { at: new Date(now).toISOString(), checkouts };
}

function handle() {
  globalThis.__hookedAutoPull ??= { timer: null, first: null, running: null, last: null };
  return globalThis.__hookedAutoPull;
}

function pullCheckoutsNow() {
  const h = handle();
  h.running ??= runAutoPull()
    .then((r) => {
      h.last = r;
      for (const c of r.checkouts) {
        if (c.result === 'pulled') console.log(`[hooked] auto-pull: ${c.path} +${c.commits} on ${c.branch}`);
        if (c.result === 'failed') console.warn(`[hooked] auto-pull: ${c.path}: ${c.why}`);
      }
      return r;
    })
    .finally(() => { h.running = null; });
  return h.running;
}

function tick() {
  if (!readSettings().autoPullProjects) return;
  pullCheckoutsNow().catch((e) => console.warn('[hooked] auto-pull:', e?.message || e));
}

function startAutoPull() {
  const h = handle();
  if (h.timer) return;
  h.first = setTimeout(tick, FIRST_TICK_MS);
  h.first.unref?.();
  h.timer = setInterval(tick, TICK_MS);
  h.timer.unref?.();
}

const lastAutoPull = () => handle().last;

export { autoPullRoots, pullCheckout, runAutoPull, pullCheckoutsNow, startAutoPull, lastAutoPull };
