import { describe, it, expect } from 'vitest';
import { htmlUrl, toPr } from '../server/github.js';

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
});
