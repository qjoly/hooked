/*
 * Blame under the cursor (server/vcsBlame.js) — real `git init` fixtures in a throwaway tmpdir,
 * like test/vcsDiff.test.mjs. Covers the porcelain parse (author/summary shared per commit),
 * the working-tree case ("Not Committed Yet"), a past revision, and the two refusals the front
 * relies on: a file outside the session's repos and a revision that could be a git flag.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const TMP = () => fs.realpathSync(path.join(os.tmpdir(), 'hooked-vcsblame-test-' + process.pid));

let buildVcsBlame;
let T;

const id = (name) => ['-c', `user.email=${name}@test`, `-c`, `user.name=${name}`, '-c', 'commit.gpgsign=false'];
async function git(cwd, name, ...args) {
  await execFileP('git', [...id(name), ...args], { cwd });
}

beforeAll(async () => {
  const raw = path.join(os.tmpdir(), 'hooked-vcsblame-test-' + process.pid);
  fs.rmSync(raw, { recursive: true, force: true });
  fs.mkdirSync(raw, { recursive: true });
  T = TMP();
  ({ buildVcsBlame } = await import('../server/vcsBlame.js'));
});
afterAll(() => { fs.rmSync(T, { recursive: true, force: true }); });

// alice writes two lines, bob rewrites the second, then the file is edited without committing.
async function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  await git(dir, 'alice', 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alice one\nalice two\n');
  await git(dir, 'alice', 'add', '.');
  await git(dir, 'alice', 'commit', '-q', '-m', 'first lines');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alice one\nbob two\n');
  await git(dir, 'bob', 'commit', '-q', '-am', 'bob rewrites line two');
  return dir;
}
const authorOf = (r, line) => r.commits[r.lines[line - 1].c];

describe('buildVcsBlame', () => {
  it('names the author of each line, sharing one commit entry per revision', async () => {
    const dir = await makeRepo(path.join(T, 'repo'));
    const r = await buildVcsBlame(dir, path.join(dir, 'a.txt'), 'HEAD');
    expect(r.supported).toBe(true);
    expect(r.root).toBe(dir);
    expect(r.lines.map((l) => l.t)).toEqual(['alice one', 'bob two']);
    expect(authorOf(r, 1)).toMatchObject({ author: 'alice', summary: 'first lines', uncommitted: false });
    expect(authorOf(r, 2)).toMatchObject({ author: 'bob', summary: 'bob rewrites line two' });
    expect(r.commits).toHaveLength(2);
    expect(authorOf(r, 1).time).toBeGreaterThan(0);
  });

  it('flags a working-tree line as not committed yet', async () => {
    const dir = await makeRepo(path.join(T, 'dirty'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alice one\nnobody yet\n');
    const r = await buildVcsBlame(dir, path.join(dir, 'a.txt'), '');
    expect(r.rev).toBe(null);
    expect(authorOf(r, 1)).toMatchObject({ author: 'alice', uncommitted: false });
    expect(authorOf(r, 2).uncommitted).toBe(true);
    expect(r.lines[1].t).toBe('nobody yet');
  });

  it('blames a past revision, ignoring what came after it', async () => {
    const dir = await makeRepo(path.join(T, 'past'));
    const r = await buildVcsBlame(dir, path.join(dir, 'a.txt'), 'HEAD^');
    expect(r.lines.map((l) => l.t)).toEqual(['alice one', 'alice two']);
    expect(authorOf(r, 2).author).toBe('alice');
  });

  it('refuses a file outside the session repos, a relative path, and a flag-like revision', async () => {
    const dir = await makeRepo(path.join(T, 'guard'));
    const outside = path.join(T, 'outside.txt');
    fs.writeFileSync(outside, 'x\n');
    expect((await buildVcsBlame(dir, outside, '')).supported).toBe(false);
    expect((await buildVcsBlame(dir, 'a.txt', '')).supported).toBe(false);
    expect((await buildVcsBlame(dir, path.join(dir, 'a.txt'), '--help')).supported).toBe(false);
    expect((await buildVcsBlame(dir, path.join(dir, 'a.txt'), '-n')).supported).toBe(false);
  });

  it('answers empty (but supported) for an untracked file', async () => {
    const dir = await makeRepo(path.join(T, 'untracked'));
    fs.writeFileSync(path.join(dir, 'new.txt'), 'fresh\n');
    const r = await buildVcsBlame(dir, path.join(dir, 'new.txt'), '');
    expect(r.supported).toBe(true);
    expect(r.lines).toEqual([]);
  });
});
