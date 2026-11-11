/*
 * hooked-owned git worktrees (server/worktrees.js): naming helpers, then create / list / remove
 * against a throwaway repository (no remote, no network, no gh).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.realpathSync(os.tmpdir()) + '/hooked-worktrees-test-' + process.pid;
const REPO = path.join(TMP, 'repo');
const LOCATION = path.join(TMP, 'wt');
process.env.HOOKED_DATA_DIR = path.join(TMP, 'data');
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
});

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let wt;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  fs.mkdirSync(process.env.HOOKED_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.HOOKED_DATA_DIR, 'settings.json'), JSON.stringify({ worktrees: { location: LOCATION } }));
  git(REPO, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(REPO, 'a.txt'), 'a\n');
  git(REPO, 'add', '.');
  git(REPO, 'commit', '-qm', 'init');
  wt = await import('../server/worktrees.js');
});

describe('sanitizeBranchName', () => {
  it('normalizes a model suggestion', () => {
    expect(wt.sanitizeBranchName(' Feat/Add Dark  Mode! ')).toBe('feat/add-dark-mode');
  });
  it('rejects what git would reject', () => {
    expect(wt.sanitizeBranchName('feat/a..b')).toBeNull();
    expect(wt.sanitizeBranchName('')).toBeNull();
    expect(wt.sanitizeBranchName(42)).toBeNull();
  });
});

describe('parseBranchSuggestion', () => {
  it('reads the branch out of the claude -p envelope', () => {
    const stdout = JSON.stringify({ type: 'result', result: 'Here: {"branch": "fix/login-redirect"}' });
    expect(wt.parseBranchSuggestion(stdout)).toBe('fix/login-redirect');
  });
  it('returns null on garbage', () => {
    expect(wt.parseBranchSuggestion('nope')).toBeNull();
  });
});

describe('parseWorktreeList', () => {
  it('parses porcelain output', () => {
    const out = 'worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /w\nHEAD def\ndetached\nlocked\n';
    expect(wt.parseWorktreeList(out)).toEqual([
      { path: '/r', head: 'abc', branch: 'main', detached: false, bare: false, locked: false, prunable: false },
      { path: '/w', head: 'def', branch: null, detached: true, bare: false, locked: true, prunable: false },
    ]);
  });
});

describe('createWorktree', () => {
  it('creates a temporary branch from the base, without upstream, in the configured location', async () => {
    const res = await wt.createWorktree({ cwd: REPO, base: 'main' });
    expect(res.branch).toMatch(/^hooked\/[0-9a-f]{8}$/);
    expect(res.path).toBe(path.join(LOCATION, res.branch.slice('hooked/'.length)));
    expect(res.autoName).toBe(true);
    expect(git(res.path, 'branch', '--show-current')).toBe(res.branch);
    expect(() => git(res.path, 'rev-parse', '--abbrev-ref', '@{u}')).toThrow();
    expect(wt.readWorktreeRegistry()[res.path]).toMatchObject({ root: REPO, base: 'main', branch: res.branch });
  });

  it('uses an explicit branch as is and refuses an existing one', async () => {
    const res = await wt.createWorktree({ cwd: REPO, base: 'main', branch: 'feat/explicit' });
    expect(res.path).toBe(path.join(LOCATION, 'feat-explicit'));
    expect(res.autoName).toBe(false);
    await expect(wt.createWorktree({ cwd: REPO, base: 'main', branch: 'feat/explicit' })).rejects.toThrow(/already exists/);
  });

  it('refuses an unknown base and a non-repository', async () => {
    await expect(wt.createWorktree({ cwd: REPO, base: 'nope' })).rejects.toThrow(/unknown base/);
    await expect(wt.createWorktree({ cwd: TMP })).rejects.toThrow(/not a git repository/);
  });
});

describe('listWorktrees / removeWorktree', () => {
  it('lists linked worktrees with their state', async () => {
    const list = await wt.listWorktrees({ projects: [REPO], withPr: false });
    const explicit = list.find((w) => w.branch === 'feat/explicit');
    expect(explicit).toMatchObject({ managed: true, root: REPO, base: 'main', unique: 0, merged: true, dirtyFiles: 0 });
  });

  it('refuses a worktree a live session uses', async () => {
    const p = path.join(LOCATION, 'feat-explicit');
    await expect(wt.removeWorktree(p, { liveCwds: [p + '/sub'] })).rejects.toThrow(/running session/);
  });

  it('removes a merged worktree and its branch', async () => {
    const p = path.join(LOCATION, 'feat-explicit');
    const res = await wt.removeWorktree(p);
    expect(res).toMatchObject({ removed: true, branch: 'feat/explicit', branchDeleted: true });
    expect(fs.existsSync(p)).toBe(false);
    expect(() => git(REPO, 'rev-parse', '--verify', 'refs/heads/feat/explicit')).toThrow();
    expect(wt.readWorktreeRegistry()[p]).toBeUndefined();
  });

  it('protects local changes and keeps a branch with its own commits', async () => {
    const res = await wt.createWorktree({ cwd: REPO, base: 'main', branch: 'feat/work' });
    fs.writeFileSync(path.join(res.path, 'b.txt'), 'b\n');
    git(res.path, 'add', '.');
    git(res.path, 'commit', '-qm', 'work');
    fs.writeFileSync(path.join(res.path, 'c.txt'), 'c\n');

    const row = (await wt.listWorktrees({ projects: [REPO], withPr: false })).find((w) => w.path === res.path);
    expect(row).toMatchObject({ unique: 1, merged: false, dirtyFiles: 1 });

    await expect(wt.removeWorktree(res.path)).rejects.toMatchObject({ dirty: true });
    const done = await wt.removeWorktree(res.path, { force: true });
    expect(done).toMatchObject({ removed: true, branchDeleted: false, keptBranch: true });
    expect(git(REPO, 'rev-parse', '--verify', 'refs/heads/feat/work')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('never removes the main checkout', async () => {
    await expect(wt.removeWorktree(REPO, { force: true })).rejects.toThrow(/not a linked git worktree/);
  });
});

describe('review against the base', () => {
  it('diffs fork point → disk: commits, uncommitted edits and untracked files together', async () => {
    const { buildVcsBaseChanges } = await import('../server/vcsDiff.js');
    const { worktreeOf } = await import('../server/git.js');
    const res = await wt.createWorktree({ cwd: REPO, base: 'main', branch: 'feat/review' });
    fs.writeFileSync(path.join(res.path, 'committed.txt'), 'c\n');
    git(res.path, 'add', '.');
    git(res.path, 'commit', '-qm', 'committed');
    fs.writeFileSync(path.join(res.path, 'a.txt'), 'a\nedited\n');
    fs.writeFileSync(path.join(res.path, 'untracked.txt'), 'u\n');
    git(REPO, 'commit', '-q', '--allow-empty', '-m', 'main moved on');

    expect(worktreeOf(res.path)).toBe(REPO);
    expect(worktreeOf(REPO)).toBeNull();
    expect(await wt.worktreeBaseFor(res.path)).toBe('main');

    const d = await buildVcsBaseChanges(res.path, 'main');
    expect(d).toMatchObject({ vcs: 'git', root: res.path, base: 'main', branch: 'feat/review', commits: 1, truncated: false });
    expect(d.mergeBase).toBe(git(res.path, 'rev-parse', 'HEAD~1'));
    expect(d.changes.map((c) => path.relative(res.path, c.file)).sort()).toEqual(['a.txt', 'committed.txt', 'untracked.txt']);
    await wt.removeWorktree(res.path, { force: true });
  });
});
