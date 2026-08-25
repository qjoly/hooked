/*
 * Working-tree VCS diff (server/vcsDiff.js) — first tests for this module. Real `git init`
 * fixtures in a throwaway tmpdir; buildVcsChanges takes a cwd directly, so no HOOKED_DATA_DIR
 * is needed. Covers the nested sub-repo detection (walk + .gitmodules union, caps, budget).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
// realpath: on macOS os.tmpdir() is a symlink (/var → /private/var) while
// `git rev-parse --show-toplevel` returns resolved paths — keep both worlds aligned.
const TMP = () => fs.realpathSync(path.join(os.tmpdir(), 'hooked-vcsdiff-test-' + process.pid));

let buildVcsChanges, scanSubRepos, listVcsCommits, buildVcsCommitChanges;
let T;

const GIT_ID = ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
async function git(cwd, ...args) {
  await execFileP('git', [...GIT_ID, ...args], { cwd });
}
// A repo with one committed file; `dirty` adds an uncommitted modification + an untracked file.
async function makeRepo(dir, { dirty = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'init');
  if (dirty) {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');
  }
  return dir;
}

beforeAll(async () => {
  const raw = path.join(os.tmpdir(), 'hooked-vcsdiff-test-' + process.pid);
  fs.rmSync(raw, { recursive: true, force: true });
  fs.mkdirSync(raw, { recursive: true });
  T = TMP();
  ({ buildVcsChanges, scanSubRepos, listVcsCommits, buildVcsCommitChanges } = await import('../server/vcsDiff.js'));
});
afterAll(() => {
  fs.rmSync(T, { recursive: true, force: true });
});

describe('buildVcsChanges — single repo (existing behavior)', () => {
  it('reports the primary repo with modified + untracked entries', async () => {
    const dir = await makeRepo(path.join(T, 'single'), { dirty: true });
    const r = await buildVcsChanges(dir);
    expect(r.vcs).toBe('git');
    expect(r.root).toBe(dir);
    expect(r.truncated).toBe(false);
    expect(r.repos).toHaveLength(1);
    expect(r.repos[0]).toMatchObject({ kind: 'git', root: dir, label: '', primary: true });
    const badges = Object.fromEntries(r.changes.map((c) => [c.name, c.badge]));
    expect(badges).toEqual({ 'a.txt': 'modified', 'new.txt': 'untracked' });
    const mod = r.changes.find((c) => c.name === 'a.txt');
    expect(mod.ops[0].old).toBe('one\n');
    expect(mod.ops[0].new).toBe('two\n');
  });

  it('returns the empty shape when the cwd is under no VCS and holds no repo', async () => {
    const dir = path.join(T, 'plain');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'loose.txt'), 'x\n');
    expect(await buildVcsChanges(dir)).toEqual({ vcs: null, root: null, changes: [], truncated: false, repos: [] });
  });
});

describe('buildVcsChanges — nested clone inside a repo', () => {
  it('reports the sub-repo and keeps its dir out of the parent diff', async () => {
    const parent = await makeRepo(path.join(T, 'nesting'), { dirty: true });
    await makeRepo(path.join(parent, 'nested'), { dirty: true });
    const r = await buildVcsChanges(parent);
    expect(r.repos.map((x) => x.label)).toEqual(['', 'nested']);
    expect(r.repos[1]).toMatchObject({ kind: 'git', primary: false });
    expect(r.repos[1].changes.map((c) => c.name).sort()).toEqual(['a.txt', 'new.txt']);
    // The nested clone must not leak into the parent as an untracked directory entry.
    expect(r.changes.some((c) => c.name === 'nested')).toBe(false);
  });
});

describe('buildVcsChanges — workspace of clones (cwd under no VCS)', () => {
  it('detects every clone under the workspace dir', async () => {
    const ws = path.join(T, 'workspace');
    await makeRepo(path.join(ws, 'a'), { dirty: true });
    await makeRepo(path.join(ws, 'b'));
    const r = await buildVcsChanges(ws);
    expect(r.vcs).toBe('git');
    expect(r.root).toBe(ws);
    expect(r.changes).toEqual([]); // no primary repo
    expect(r.repos.map((x) => [x.label, x.changes.length])).toEqual([['a', 2], ['b', 0]]);
  });
});

describe('scanSubRepos — bounds', () => {
  it('honors the depth cap and the ignore list, and skips symlink cycles', async () => {
    const base = path.join(T, 'bounds');
    await makeRepo(path.join(base, 'l1', 'l2', 'shallow'));           // depth 3 → found
    await makeRepo(path.join(base, 'l1', 'l2', 'l3', 'l4', 'deep'));  // depth 5 → too deep
    await makeRepo(path.join(base, 'node_modules', 'dep'));           // ignored dir
    fs.symlinkSync('..', path.join(base, 'l1', 'loop'));              // cycle bait
    const roots = scanSubRepos(base).map((s) => path.relative(base, s.root));
    expect(roots).toEqual([path.join('l1', 'l2', 'shallow')]);
  });
});

describe('buildVcsChanges — .gitmodules union', () => {
  it('finds an initialized submodule living under an ignored dir', async () => {
    const parent = await makeRepo(path.join(T, 'withsub'));
    // Hand-written .gitmodules (git submodule add needs protocol.file.allow on modern git).
    fs.writeFileSync(path.join(parent, '.gitmodules'),
      '[submodule "dep"]\n\tpath = vendor/dep\n\turl = ./dep\n');
    await makeRepo(path.join(parent, 'vendor', 'dep'), { dirty: true });
    const r = await buildVcsChanges(parent);
    const sub = r.repos.find((x) => x.label === path.join('vendor', 'dep'));
    expect(sub).toBeTruthy();
    expect(sub.changes.length).toBe(2);
  });
});

describe('listVcsCommits / buildVcsCommitChanges — git', () => {
  // A repo with two commits: init (a.txt "one") then "second" (a.txt → "two", b.txt added).
  async function makeHistory(dir) {
    await makeRepo(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-q', '-m', 'second');
    return dir;
  }

  it('lists commits newest first with full hex revs and subjects', async () => {
    const dir = await makeHistory(path.join(T, 'log'));
    const r = await listVcsCommits(dir);
    expect(r.vcs).toBe('git');
    expect(r.root).toBe(dir);
    expect(r.commits.map((c) => c.subject)).toEqual(['second', 'init']);
    expect(r.commits.every((c) => /^[0-9a-f]{40}$/.test(c.rev))).toBe(true);
    expect(r.commits[0].author).toBe('t');
  });

  it('diffs one commit against its parent', async () => {
    const dir = await makeHistory(path.join(T, 'commitdiff'));
    const { commits } = await listVcsCommits(dir);
    const r = await buildVcsCommitChanges(dir, commits[0].rev);
    expect(r.vcs).toBe('git');
    const byName = Object.fromEntries(r.changes.map((c) => [c.name, c]));
    expect(byName['a.txt'].badge).toBe('modified');
    expect(byName['a.txt'].ops[0].old).toBe('one\n');
    expect(byName['a.txt'].ops[0].new).toBe('two\n');
    expect(byName['b.txt'].badge).toBe('added');
    expect(byName['b.txt'].ops[0].new).toBe('bee\n');
  });

  it('diffs a root commit against the empty tree', async () => {
    const dir = await makeHistory(path.join(T, 'rootdiff'));
    const { commits } = await listVcsCommits(dir);
    const r = await buildVcsCommitChanges(dir, commits[1].rev);
    expect(r.changes.map((c) => [c.name, c.badge])).toEqual([['a.txt', 'added']]);
    expect(r.changes[0].ops[0].new).toBe('one\n');
  });

  it('rejects a non-hex rev (argv injection guard) and an unknown project', async () => {
    const dir = await makeHistory(path.join(T, 'badrev'));
    const empty = { vcs: null, root: null, changes: [] };
    expect(await buildVcsCommitChanges(dir, 'HEAD')).toEqual(empty);
    expect(await buildVcsCommitChanges(dir, '--help')).toEqual(empty);
    expect(await buildVcsCommitChanges(null, 'abcdef')).toEqual(empty);
  });

  it('returns the empty shape when the cwd is under no VCS', async () => {
    const dir = path.join(T, 'log-novcs');
    fs.mkdirSync(dir, { recursive: true });
    expect(await listVcsCommits(dir)).toEqual({ vcs: null, root: null, commits: [] });
  });

  it('targets a detected sub-repo via repoRoot, and rejects an arbitrary path', async () => {
    const parent = await makeHistory(path.join(T, 'log-sub'));
    const sub = await makeRepo(path.join(parent, 'nested'));
    // Sub-repo history + its commit diff, addressed by root.
    const log = await listVcsCommits(parent, sub);
    expect(log.root).toBe(sub);
    expect(log.commits.map((c) => c.subject)).toEqual(['init']);
    const diff = await buildVcsCommitChanges(parent, log.commits[0].rev, sub);
    expect(diff.root).toBe(sub);
    expect(diff.changes.map((c) => [c.name, c.badge])).toEqual([['a.txt', 'added']]);
    // A root outside the detected list must not be honored.
    const outside = await makeRepo(path.join(T, 'log-outside'));
    expect(await listVcsCommits(parent, outside)).toEqual({ vcs: null, root: null, commits: [] });
    expect(await buildVcsCommitChanges(parent, log.commits[0].rev, outside)).toEqual({ vcs: null, root: null, changes: [] });
  });
});

describe('buildVcsChanges — global file budget', () => {
  it('lists budget-starved repos with empty changes and flags truncation', async () => {
    const parent = await makeRepo(path.join(T, 'budget'));
    for (let i = 0; i < 61; i++) fs.writeFileSync(path.join(parent, `f${i}.txt`), 'x\n');
    await makeRepo(path.join(parent, 'sub'), { dirty: true });
    const r = await buildVcsChanges(parent);
    expect(r.truncated).toBe(true);
    expect(r.changes.length).toBe(60);
    const sub = r.repos.find((x) => x.label === 'sub');
    expect(sub.changes).toEqual([]);
  });
});
