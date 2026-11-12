/*
 * Git worktrees owned by hooked. A "New worktree" launch creates the checkout here, then starts the
 * session in it with a plain `cwd`: the path and branch are known before the CLI spawns, which is
 * what makes reuse, listing and cleanup possible.
 *
 * Managed worktrees are recorded in worktrees.json ({ [path]: { root, base, branch, autoName,
 * createdAt, sessions } }). Listing and removal also cover linked worktrees hooked did not create
 * (`claude --worktree`, made by hand), found through the repositories of known sessions.
 *
 * Removing a managed worktree keeps its entry with `removedAt` and the last `head`: the branch
 * outlives the checkout, so resuming one of its sessions can check it out again at the same path
 * (the transcript's cwd).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { HOME, HOOKED_DIR } from './config.js';
import { readSettings } from './settings.js';
import { isValidBranchName } from './gitOps.js';
import { runClaude } from './mcp.js';
import { modelJson } from './claudeJson.js';
import { ghGraphql, parseGithubRemote } from './ghClient.js';

const REGISTRY_FILE = () => path.join(HOOKED_DIR, 'worktrees.json');
const DEFAULT_LOCATION = () => path.join(HOOKED_DIR, 'worktrees');
const ADD_TIMEOUT = 5 * 60_000;
const GIT_TIMEOUT = 60_000;
const NAME_TIMEOUT = 90_000;
const TEMP_PREFIX = 'hooked/';
const RECORD_TTL_MS = 180 * 86_400_000;

function git(cwd, args, timeout = GIT_TIMEOUT) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
    });
  });
}

function readRegistry() {
  try {
    const j = JSON.parse(fs.readFileSync(REGISTRY_FILE(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (_) { return {}; }
}
function writeRegistry(map) {
  fs.mkdirSync(HOOKED_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE(), JSON.stringify(map, null, 2) + '\n');
}
function updateEntry(wtPath, patch) {
  const map = readRegistry();
  if (patch === null) delete map[wtPath];
  else map[wtPath] = { ...(map[wtPath] || {}), ...patch };
  writeRegistry(map);
}

function expandHome(p) {
  if (p === '~') return HOME;
  return p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p;
}
function worktreeLocation(settings = readSettings()) {
  const loc = settings.worktrees && settings.worktrees.location;
  return loc ? expandHome(loc) : DEFAULT_LOCATION();
}

function flattenBranch(branch) {
  return branch.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'worktree';
}

function sanitizeBranchName(raw) {
  if (typeof raw !== 'string') return null;
  const b = raw.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .replace(/(^|\/)[-.]+/g, '$1')
    .replace(/[-./]+$/g, '')
    .slice(0, 60)
    .replace(/[-./]+$/g, '');
  return b && isValidBranchName(b) && !b.includes('/.') && !b.endsWith('.lock') ? b : null;
}

function parseWorktreeList(stdout) {
  const out = [];
  let cur = null;
  for (const line of String(stdout || '').split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return out;
}

async function repoRoot(cwd) {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok && r.out ? r.out : null;
}

async function defaultBase(root) {
  const head = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.out) return head.out;
  const cur = await git(root, ['branch', '--show-current']);
  return cur.ok && cur.out ? cur.out : 'HEAD';
}

async function refExists(root, ref) {
  return (await git(root, ['rev-parse', '--verify', '--quiet', ref])).ok;
}

async function listBases(cwd) {
  const root = await repoRoot(cwd);
  if (!root) return { root: null, error: 'not a git repository' };
  const [def, refs] = await Promise.all([
    defaultBase(root),
    git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']),
  ]);
  const names = refs.out.split('\n').map((s) => s.trim()).filter((s) => s && !/\/HEAD$/.test(s) && s !== 'origin');
  return { root, defaultBase: def, branches: [...new Set([def, ...names])].slice(0, 300) };
}

// A remote-tracking base is fetched first so the worktree starts from the remote's tip, not from
// whenever this clone last fetched. Best effort: offline, the local ref still works.
async function fetchBase(root, base) {
  const remotes = (await git(root, ['remote'])).out.split('\n').filter(Boolean);
  const remote = remotes.find((r) => base.startsWith(r + '/'));
  if (!remote) return;
  await git(root, ['fetch', '--quiet', remote, base.slice(remote.length + 1)], ADD_TIMEOUT);
}

async function uniqueBranch(root, wanted) {
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? wanted : `${wanted}-${i}`;
    if (!(await refExists(root, 'refs/heads/' + name))) return name;
  }
  return null;
}

function uniqueDir(location, name) {
  const registry = readRegistry();
  for (let i = 1; i < 100; i++) {
    const p = path.join(location, i === 1 ? name : `${name}-${i}`);
    if (!fs.existsSync(p) && !registry[p]) return p;
  }
  return null;
}

async function createWorktree({ cwd, base, branch }) {
  const root = await repoRoot(cwd);
  if (!root) throw new Error('not a git repository: ' + cwd);
  const baseRef = typeof base === 'string' && base.trim() ? base.trim() : await defaultBase(root);
  if (baseRef !== 'HEAD' && !isValidBranchName(baseRef)) throw new Error('invalid base branch: ' + baseRef);
  await fetchBase(root, baseRef);
  if (!(await refExists(root, baseRef + '^{commit}'))) throw new Error('unknown base branch: ' + baseRef);

  const wanted = typeof branch === 'string' && branch.trim() ? branch.trim() : null;
  let name;
  if (wanted) {
    if (!isValidBranchName(wanted) || !(await git(root, ['check-ref-format', '--branch', wanted])).ok) throw new Error('invalid branch name: ' + wanted);
    if (await refExists(root, 'refs/heads/' + wanted)) throw new Error(`branch '${wanted}' already exists`);
    name = wanted;
  } else {
    name = await uniqueBranch(root, TEMP_PREFIX + crypto.randomBytes(4).toString('hex'));
    if (!name) throw new Error('could not pick a branch name');
  }

  const location = worktreeLocation();
  fs.mkdirSync(location, { recursive: true });
  const dir = uniqueDir(location, flattenBranch(wanted || name.slice(TEMP_PREFIX.length)));
  if (!dir) throw new Error('could not pick a worktree directory in ' + location);

  // --no-track: a branch started from origin/main would otherwise track main, and with
  // push.default=upstream a bare `git push` lands on main.
  const add = await git(root, ['worktree', 'add', '--no-track', '-b', name, dir, baseRef], ADD_TIMEOUT);
  if (!add.ok) throw new Error('git worktree add failed: ' + add.err.split('\n').pop());
  const wt = { root, base: baseRef, branch: name, autoName: !wanted, createdAt: new Date().toISOString(), sessions: [] };
  updateEntry(dir, wt);
  return { path: dir, ...wt };
}

function attachSession(wtPath, sessionId) {
  const map = readRegistry();
  const e = map[wtPath];
  if (!e || !sessionId) return;
  e.sessions = [...new Set([...(e.sessions || []), sessionId])];
  writeRegistry(map);
}

function buildNamePrompt(prompt, instructions) {
  return `Name the git branch for a coding task. Reply with JSON only: {"branch": "..."}.
Rules:
- Format <type>/<short-kebab-description>, type one of feat, fix, chore, docs, refactor, test, perf, ci.
- Lowercase ASCII, at most 40 characters, no issue numbers unless the task names one.
${instructions ? `Additional instructions (they win over the rules above):\n${instructions}\n` : ''}
Task:
${String(prompt || '').slice(0, 2000)}`;
}

function parseBranchSuggestion(stdout) {
  const obj = modelJson(stdout);
  return obj && typeof obj.branch === 'string' ? sanitizeBranchName(obj.branch) : null;
}

async function suggestBranchName(prompt, instructions) {
  const args = [
    '-p', buildNamePrompt(prompt, instructions),
    '--model', 'haiku', '--output-format', 'json',
    '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
    '--settings', JSON.stringify({ disableAllHooks: true }),
  ];
  const { stdout } = await runClaude(args, os.tmpdir(), NAME_TIMEOUT);
  return parseBranchSuggestion(stdout);
}

// Runs in the background while the session already works on the temporary branch. `branch -m`
// renames the branch under the running agent without touching its files.
async function autoNameBranch(wtPath, prompt) {
  const settings = readSettings();
  const e = readRegistry()[wtPath];
  if (!e || !e.autoName || !prompt || settings.worktrees?.autoName === false) return null;
  const suggested = await suggestBranchName(prompt, settings.worktrees?.nameInstructions || '');
  if (!suggested) return null;
  if (!(await refExists(wtPath, 'refs/heads/' + e.branch))) { updateEntry(wtPath, { autoName: false }); return null; }
  const name = await uniqueBranch(wtPath, suggested);
  if (!name) return null;
  const r = await git(wtPath, ['branch', '-m', e.branch, name]);
  if (!r.ok) throw new Error('git branch -m failed: ' + r.err);
  updateEntry(wtPath, { branch: name, autoName: false });
  return name;
}

// The base a checkout is reviewed against: the one recorded when hooked created the worktree,
// else the remote default branch.
async function worktreeBaseFor(cwd) {
  const top = await repoRoot(cwd);
  if (!top) return null;
  return readRegistry()[top]?.base || defaultBase(top);
}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');
}

const PR_FOR_BRANCH = `query($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { number state url headRefOid baseRefName }
    }
  }
}`;

// A fork's PR lives on `upstream`, so that remote is asked first.
async function githubRepoOf(cwd) {
  for (const remote of ['upstream', 'origin']) {
    const r = await git(cwd, ['remote', 'get-url', remote]);
    const repo = r.ok && parseGithubRemote(r.out);
    if (repo) return repo;
  }
  return null;
}

async function prFor(wtPath, branch) {
  try {
    const repo = await githubRepoOf(wtPath);
    if (!repo) return null;
    const data = await ghGraphql(PR_FOR_BRANCH, { ...repo, head: branch });
    return data.repository?.pullRequests?.nodes?.[0] || null;
  } catch (_) { return null; }
}

// `merged` holds when the branch has nothing beyond its base (fast-forward and merge-commit merges
// land there too), or when its PR was squash/rebase-merged while the worktree still sits on the
// PR's last commit.
async function worktreeStatus(wt, { base, withPr = true } = {}) {
  if (wt.prunable || !fs.existsSync(wt.path)) return { missing: true };
  const [porcelain, ahead] = await Promise.all([
    git(wt.path, ['status', '--porcelain']),
    base ? git(wt.path, ['rev-list', '--count', `${base}..HEAD`]) : Promise.resolve({ ok: false }),
  ]);
  const dirtyFiles = porcelain.ok && porcelain.out ? porcelain.out.split('\n').length : 0;
  const unique = ahead.ok ? parseInt(ahead.out, 10) || 0 : null;
  let pr = null;
  if (withPr && wt.branch && unique) pr = await prFor(wt.path, wt.branch);
  const squashed = !!(pr && pr.state === 'MERGED' && pr.headRefOid === wt.head);
  return {
    missing: false,
    dirtyFiles,
    unique,
    pr: pr ? { number: pr.number, state: pr.state, url: pr.url } : null,
    merged: unique === 0 || squashed,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function listWorktrees({ projects = [], sessions = [], withPr = true } = {}) {
  const registry = readRegistry();
  const roots = new Set(Object.values(registry).map((e) => e.root).filter(Boolean));
  const tops = await mapLimit([...new Set(projects.filter(Boolean))], 8, async (p) => (fs.existsSync(p) ? repoRoot(p) : null));
  for (const t of tops) if (t) roots.add(t);

  const commons = new Map();
  await mapLimit([...roots], 8, async (r) => {
    if (!fs.existsSync(r)) return;
    const common = await git(r, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (common.ok && !commons.has(common.out)) commons.set(common.out, r);
  });

  const rows = [];
  await mapLimit([...commons.values()], 8, async (r) => {
    const list = await git(r, ['worktree', 'list', '--porcelain']);
    if (!list.ok) return;
    const [main, ...linked] = parseWorktreeList(list.out);
    if (!main || main.bare) return;
    for (const wt of linked) rows.push({ ...wt, root: main.path });
  });

  const known = new Set(rows.map((r) => r.path));
  const now = Date.now();
  const stale = Object.keys(registry).filter((p) => !known.has(p) && !fs.existsSync(p)
    && (!registry[p].removedAt || now - Date.parse(registry[p].removedAt) > RECORD_TTL_MS));
  if (stale.length) { const map = readRegistry(); for (const p of stale) delete map[p]; writeRegistry(map); }

  const defaults = new Map();
  const result = await mapLimit(rows, 6, async (wt) => {
    const entry = registry[wt.path];
    if (!defaults.has(wt.root)) defaults.set(wt.root, defaultBase(wt.root));
    const base = entry?.base || await defaults.get(wt.root);
    const status = await worktreeStatus(wt, { base, withPr });
    const users = sessions.filter((s) => s.project && isInside(s.project, wt.path));
    return {
      path: wt.path,
      root: wt.root,
      branch: wt.branch,
      head: wt.head,
      detached: wt.detached,
      locked: wt.locked,
      managed: !!entry,
      base,
      createdAt: entry?.createdAt || null,
      sessions: users.map((s) => s.id),
      live: users.filter((s) => s.live).map((s) => s.id),
      ...status,
    };
  });
  result.sort((a, b) => (b.managed - a.managed) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || a.path.localeCompare(b.path));
  return result;
}

async function findLinkedWorktree(anyPath) {
  const top = fs.existsSync(anyPath) ? await repoRoot(anyPath) : null;
  if (!top) return null;
  const list = await git(top, ['worktree', 'list', '--porcelain']);
  const [main, ...linked] = parseWorktreeList(list.out);
  const wt = linked.find((w) => w.path === top);
  return wt && main ? { ...wt, root: main.path } : null;
}

async function removeWorktree(target, { force = false, liveCwds = [], forget = false } = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('absolute worktree path required');
  const registry = readRegistry();
  const wt = await findLinkedWorktree(target);
  if (!wt) {
    if (registry[target] && !fs.existsSync(target)) {
      if (forget || !registry[target].removedAt) updateEntry(target, null);
      return { removed: true, branchDeleted: false };
    }
    throw new Error('not a linked git worktree: ' + target);
  }
  const wtPath = wt.path;
  if (liveCwds.some((c) => c && isInside(c, wtPath))) throw new Error('a running session uses this worktree — archive it first');
  const base = registry[wtPath]?.base || await defaultBase(wt.root);
  const status = await worktreeStatus(wt, { base });
  if (status.dirtyFiles && !force) {
    const e = new Error(`${status.dirtyFiles} uncommitted change(s) in the worktree`);
    e.dirty = true;
    throw e;
  }
  const rm = await git(wt.root, ['worktree', 'remove', ...(force ? (wt.locked ? ['--force', '--force'] : ['--force']) : []), wtPath], ADD_TIMEOUT);
  if (!rm.ok) throw new Error('git worktree remove failed: ' + rm.err.split('\n').pop());
  let branchDeleted = false;
  if (wt.branch && status.merged) {
    branchDeleted = (await git(wt.root, ['branch', '-D', wt.branch])).ok;
  }
  if (registry[wtPath]) {
    updateEntry(wtPath, forget ? null : { removedAt: new Date().toISOString(), head: wt.head, branch: wt.branch || registry[wtPath].branch });
  }
  return { removed: true, branch: wt.branch, branchDeleted, keptBranch: !!wt.branch && !branchDeleted };
}

function removedRecordFor(dir) {
  const registry = readRegistry();
  const hit = Object.keys(registry).find((p) => registry[p].removedAt && isInside(dir, p));
  return hit ? { path: hit, ...registry[hit] } : null;
}

// Checks a removed managed worktree out again, from its branch when it still exists, else from
// the commit it was removed at. Returns null when hooked never removed anything there.
async function restoreWorktree(dir) {
  const rec = typeof dir === 'string' ? removedRecordFor(dir) : null;
  if (!rec) return null;
  if (fs.existsSync(rec.path)) throw new Error(`${rec.path} exists but is not the removed worktree`);
  if (!rec.root || !fs.existsSync(rec.root)) throw new Error('repository is gone: ' + rec.root);
  const hasBranch = !!rec.branch && await refExists(rec.root, 'refs/heads/' + rec.branch);
  if (!hasBranch && !rec.head) throw new Error(`branch ${rec.branch} no longer exists`);
  const args = hasBranch
    ? ['worktree', 'add', rec.path, rec.branch]
    : ['worktree', 'add', '--no-track', '-b', rec.branch, rec.path, rec.head];
  const add = await git(rec.root, args, ADD_TIMEOUT);
  if (!add.ok) throw new Error('git worktree add failed: ' + add.err.split('\n').pop());
  const map = readRegistry();
  const { removedAt: _r, head: _h, ...rest } = map[rec.path] || {};
  map[rec.path] = { ...rest, restoredAt: new Date().toISOString() };
  writeRegistry(map);
  return { path: rec.path, branch: rec.branch };
}

export {
  worktreeLocation,
  flattenBranch,
  sanitizeBranchName,
  parseWorktreeList,
  buildNamePrompt,
  parseBranchSuggestion,
  listBases,
  worktreeBaseFor,
  createWorktree,
  attachSession as attachWorktreeSession,
  autoNameBranch,
  listWorktrees,
  removeWorktree,
  restoreWorktree,
  worktreeStatus,
  isInside as isInsidePath,
  readRegistry as readWorktreeRegistry,
};
