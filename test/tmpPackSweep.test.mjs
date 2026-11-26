import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.realpathSync(os.tmpdir()) + '/hooked-tmppack-test-' + process.pid;
process.env.HOOKED_DATA_DIR = path.join(TMP, 'data');

const OLD = Date.now() - 60 * 60_000;
const touch = (file, mtime) => {
  fs.writeFileSync(file, 'x');
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
};

let sweepStaleTmpPacks;
let gitSyncTick;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(process.env.HOOKED_DATA_DIR, { recursive: true });
  ({ sweepStaleTmpPacks } = await import('../server/git.js'));
  ({ gitSyncTick } = await import('../server/gitOps.js'));
});

describe('sweepStaleTmpPacks', () => {
  it('removes only tmp_pack_* files older than the grace period', () => {
    const dir = path.join(TMP, 'pack');
    fs.mkdirSync(dir, { recursive: true });
    touch(path.join(dir, 'tmp_pack_old'), OLD);
    touch(path.join(dir, 'tmp_pack_fresh'));
    touch(path.join(dir, 'pack-abc.pack'), OLD);
    expect(sweepStaleTmpPacks(dir)).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual(['pack-abc.pack', 'tmp_pack_fresh']);
  });

  it('returns 0 for a missing directory', () => {
    expect(sweepStaleTmpPacks(path.join(TMP, 'nope'))).toBe(0);
  });
});

describe('gitSyncTick', () => {
  it('reports a failed fetch and sweeps stale tmp_pack files', async () => {
    const repo = path.join(TMP, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', path.join(TMP, 'missing.git')]);
    const stale = path.join(repo, '.git', 'objects', 'pack', 'tmp_pack_stale');
    touch(stale, OLD);
    const r = await gitSyncTick({}, repo);
    expect(r.skipped).toBe('fetch-failed');
    expect(r.error).toBeTruthy();
    expect(fs.existsSync(stale)).toBe(false);
  });
});
