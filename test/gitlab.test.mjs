import { describe, it, expect } from 'vitest';
import { parseGitlabUrl, filesFromPatches, toNotes, toJob, glabView } from '../server/gitlab.js';
import { prLabel } from '../src/lib/format.js';

const MR = 'https://gitlab.com/group/sub/repo/-/merge_requests/389';

describe('GitLab links', () => {
  it('parses MRs, issues and work items on any host, nested groups included', () => {
    expect(parseGitlabUrl(MR)).toEqual({ host: 'gitlab.com', kind: 'pr', base: 'projects/group%2Fsub%2Frepo/merge_requests/389' });
    expect(parseGitlabUrl('https://git.corp.io/a/b/-/work_items/4')).toEqual({ host: 'git.corp.io', kind: 'issue', base: 'projects/a%2Fb/issues/4' });
    expect(parseGitlabUrl('https://github.com/o/r/pull/1')).toBeNull();
  });

  it('returns null for non-GitLab URLs without spawning glab', async () => {
    await expect(glabView('https://example.com/a/b')).resolves.toBeNull();
  });

  it('labels MRs with ! and issues with #', () => {
    expect(prLabel(MR)).toBe('repo !389');
    expect(prLabel('https://gitlab.com/a/repo/-/issues/7')).toBe('repo #7');
    expect(prLabel('https://github.com/o/repo/pull/12')).toBe('repo #12');
  });

  it('counts hunk lines only, not the ---/+++ headers', () => {
    const p = 'diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1,2 @@\n+a\n+b';
    expect(filesFromPatches({ x: p })).toEqual([{ path: 'x', additions: 2, deletions: 0, change: 'ADDED' }]);
  });

  it('splits notes into comments and approval reviews, dropping other system notes', () => {
    const { comments, reviews } = toNotes([
      { id: 1, system: true, body: 'approved this merge request', author: { username: 'bob' }, created_at: 't1' },
      { id: 2, system: true, body: 'added 1 commit', author: { username: 'bob' }, created_at: 't2' },
      { id: 3, system: false, body: 'lgtm', author: { username: 'renovate-bot', bot: true }, created_at: 't3' },
    ], MR);
    expect(reviews).toEqual([{ kind: 'review', at: 't1', author: 'bob', state: 'APPROVED', text: '' }]);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ bot: true, url: `${MR}#note_3` });
  });

  it('treats an allowed failure as neutral', () => {
    expect(toJob({ name: 'lint', status: 'failed', allow_failure: true }).status).toBe('neutral');
    expect(toJob({ name: 'lint', status: 'running' }).status).toBe('pending');
  });
});
