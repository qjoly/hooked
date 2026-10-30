import { describe, it, expect } from 'vitest';
import { htmlUrl, toPr, toCheck, toPrDetail, isBotLogin, splitPatch, markNotificationsDone, toRun, cleanJobLog } from '../server/github.js';
import { parseRunUrl } from '../src/lib/ghRun.js';

describe('github page helpers', () => {
  it('maps notification API URLs to their web page', () => {
    expect(htmlUrl('https://api.github.com/repos/o/r/pulls/12')).toBe('https://github.com/o/r/pull/12');
    expect(htmlUrl('https://api.github.com/repos/o/r/issues/3')).toBe('https://github.com/o/r/issues/3');
    expect(htmlUrl('https://api.github.com/repos/o/r/commits/abc')).toBe('https://github.com/o/r/commit/abc');
    expect(htmlUrl('https://api.github.com/repos/o/r/releases/9', 'https://github.com/o/r')).toBe('https://github.com/o/r');
    expect(htmlUrl(null, 'https://github.com/o/r')).toBe('https://github.com/o/r');
  });

  it('flattens a GraphQL PR node', () => {
    const pr = toPr({
      number: 1, title: 't', url: 'u', isDraft: false, updatedAt: 'x', reviewDecision: 'APPROVED',
      repository: { nameWithOwner: 'o/r' }, author: { login: 'me' },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
      latestReviews: { nodes: [{ author: { login: 'bob' }, state: 'APPROVED', submittedAt: 'y', url: 'v' }] },
      reviewRequests: { nodes: [{ requestedReviewer: { name: 'team' } }, { requestedReviewer: {} }] },
      comments: { totalCount: 2 },
    });
    expect(pr).toMatchObject({ repo: 'o/r', checks: 'FAILURE', decision: 'APPROVED', requested: ['team'], comments: 2 });
    expect(pr.reviews[0]).toEqual({ author: 'bob', state: 'APPROVED', at: 'y', url: 'v' });
  });

  // The id lands in a DELETE path: anything but a thread id could aim it at another endpoint.
  it('refuses to mark anything but thread ids as done', async () => {
    await expect(markNotificationsDone(['../../repos/o/r'])).rejects.toThrow(/thread ids/);
    await expect(markNotificationsDone(['12', '13?x=1'])).rejects.toThrow(/thread ids/);
    await expect(markNotificationsDone('12')).rejects.toThrow(/thread ids/);
  });
});

describe('github detail panel', () => {
  it('folds check runs and status contexts into one vocabulary', () => {
    expect(toCheck({ __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'u' }))
      .toEqual({ name: 'a', workflow: '', status: 'failed', url: 'u' });
    expect(toCheck({ __typename: 'CheckRun', name: 'b', status: 'IN_PROGRESS', conclusion: '' }).status).toBe('pending');
    expect(toCheck({ __typename: 'StatusContext', context: 'C-3PO', state: 'SUCCESS', targetUrl: '' }))
      .toMatchObject({ name: 'C-3PO', status: 'passed' });
  });

  it('builds a dated timeline and flags drafts and bots', () => {
    const d = toPrDetail({
      number: 1, state: 'OPEN', isDraft: true, author: { login: 'me' },
      commits: [{ committedDate: '2026-01-02', oid: 'abcdef123', messageHeadline: 'fix', authors: [{ login: 'me' }] }],
      reviews: [
        { submittedAt: '2026-01-03', author: { login: 'bob' }, state: 'APPROVED', body: '' },
        { submittedAt: '2026-01-04', author: { login: 'bob' }, state: 'COMMENTED', body: '' },
      ],
      comments: [{ createdAt: '2026-01-01', author: { login: 'acme-renovate' }, body: 'hi' }],
    });
    expect(d.state).toBe('DRAFT');
    expect(d.timeline.map((e) => e.kind)).toEqual(['comment', 'commit', 'review']);
    expect(d.timeline[1].sha).toBe('abcdef1');
    expect(d.comments[0].bot).toBe(true);
    expect(isBotLogin('alice')).toBe(false);
  });

  it('splits a unified patch per file', () => {
    const p = splitPatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n-a\n+b\ndiff --git a/gone b/gone\n--- a/gone\n+++ /dev/null\n@@\n-z\n');
    expect(Object.keys(p)).toEqual(['x', 'gone']);
    expect(p.x).toMatch(/^diff --git a\/x b\/x[\s\S]*\+b$/);
  });
});

describe('github actions run', () => {
  it('recognises run and job URLs only', () => {
    expect(parseRunUrl('https://github.com/o/r/actions/runs/12')).toEqual({ repo: 'o/r', run: '12', job: '' });
    expect(parseRunUrl('https://github.com/o/r/actions/runs/12/job/34?pr=5')).toEqual({ repo: 'o/r', run: '12', job: '34' });
    expect(parseRunUrl('https://github.com/o/r/actions/runs/12/attempts/2')).toEqual({ repo: 'o/r', run: '12', job: '' });
    expect(parseRunUrl('https://github.com/o/r/actions/workflows/ci.yml')).toBeNull();
    expect(parseRunUrl('https://github.com/o/r/actions/runs/12x')).toBeNull();
  });

  it('maps run, job and step states, and drops the zero date', () => {
    const r = toRun({
      displayTitle: 't', workflowName: 'CI', status: 'in_progress', conclusion: '', url: 'u', jobs: [{
        databaseId: 7, name: 'build', status: 'completed', conclusion: 'failure', url: 'ju', startedAt: '2026-01-01T00:00:00Z',
        steps: [{ name: 'a', status: 'queued', conclusion: '', startedAt: '0001-01-01T00:00:00Z' }],
      }],
    });
    expect(r.status).toBe('pending');
    expect(r.jobs[0]).toMatchObject({ id: '7', status: 'failed' });
    expect(r.jobs[0].steps[0]).toMatchObject({ status: 'pending', startedAt: '' });
  });

  it('cleans a raw job log', () => {
    const raw = '\uFEFF2026-10-30T13:14:03.6064736Z ##[group]Setup\n2026-10-30T13:14:03.6Z \x1b[31mboom\x1b[0m\n2026-10-30T13:14:03.6Z ##[endgroup]\n2026-10-30T13:14:04Z ##[error]Process exited\n';
    expect(cleanJobLog(raw)).toBe('▸ Setup\nboom\n##[error]Process exited');
  });
});
