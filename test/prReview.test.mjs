import { describe, it, expect } from 'vitest';
import { prReviewPrompt } from '../server/prReview.js';

describe('review a pull request in a session', () => {
  it('keeps the review in the session and the checkout untouched', () => {
    const p = prReviewPrompt({ url: 'https://github.com/o/r/pull/7', repo: 'o/r', number: 7, checkout: '/src/r' });
    expect(p).toMatch(/Do NOT post anything to GitHub/);
    expect(p).toContain('gh pr diff 7 -R o/r');
    expect(p).toContain('git fetch origin pull/7/head');
    expect(p).toMatch(/Do not check out/);
  });

  it('reads files through the API when there is no local checkout', () => {
    const p = prReviewPrompt({ url: 'https://github.com/o/r/pull/7', repo: 'o/r', number: 7, checkout: null });
    expect(p).toContain('gh api repos/o/r/contents/');
    expect(p).not.toContain('git fetch');
  });
});
