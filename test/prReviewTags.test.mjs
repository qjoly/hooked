/*
 * Auto-tag scheduler (server/prReviewTags.js) — prReviewTick() only, unit-level: scanSessions
 * and ghView are mocked, tags.js runs for real against a throwaway HOOKED_DATA_DIR.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'hooked-pr-review-test-' + process.pid);
process.env.HOOKED_DATA_DIR = TMP;

let sessions = [];
let reviewByUrl = {};

vi.mock('../server/transcript.js', () => ({ scanSessions: () => sessions }));
vi.mock('../server/ghMeta.js', () => ({ ghView: async (url) => reviewByUrl[url] || null }));

let prReviewTick, readTags, setTags;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  ({ readTags, setTags } = await import('../server/tags.js'));
  ({ prReviewTick } = await import('../server/prReviewTags.js'));
});

describe('prReviewTick', () => {
  it('tags a session pr-approved when its latest PR is approved', async () => {
    sessions = [{ id: 's1', prLinks: ['https://github.com/o/r/pull/1'] }];
    reviewByUrl = { 'https://github.com/o/r/pull/1': { reviewDecision: 'APPROVED' } };
    await prReviewTick();
    expect(readTags().s1).toEqual(['pr-approved']);
  });

  it('replaces pr-changes-requested with pr-approved when the decision flips, keeping manual tags', async () => {
    setTags('s2', ['urgent', 'pr-changes-requested']);
    sessions = [{ id: 's2', prLinks: ['https://github.com/o/r/pull/2'] }];
    reviewByUrl = { 'https://github.com/o/r/pull/2': { reviewDecision: 'APPROVED' } };
    await prReviewTick();
    expect(readTags().s2).toEqual(['urgent', 'pr-approved']);
  });

  it('leaves sessions untouched when there is no PR link or no decision yet', async () => {
    sessions = [{ id: 's3', prLinks: [] }, { id: 's4', prLinks: ['https://github.com/o/r/pull/4'] }];
    reviewByUrl = { 'https://github.com/o/r/pull/4': { reviewDecision: '' } };
    await prReviewTick();
    expect(readTags().s3).toBeUndefined();
    expect(readTags().s4).toBeUndefined();
  });

  it('is a no-op when the session is already tagged with the current decision', async () => {
    setTags('s5', ['pr-approved']);
    sessions = [{ id: 's5', prLinks: ['https://github.com/o/r/pull/5'] }];
    reviewByUrl = { 'https://github.com/o/r/pull/5': { reviewDecision: 'APPROVED' } };
    await prReviewTick();
    expect(readTags().s5).toEqual(['pr-approved']);
  });
});
