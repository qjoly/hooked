import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'hooked-pr-watch-test-' + process.pid);
process.env.HOOKED_DATA_DIR = TMP;

const live = { alive: new Set(), busy: new Set(), sent: [] };
let prs = {};
let settings = { autoPrWatch: false };
let sessions = [];

vi.mock('../server/agent.js', () => ({
  agentAlive: (id) => live.alive.has(id),
  agentBusy: (id) => live.busy.has(id),
  agentPendingAsk: () => null,
  deliverReply: (id, text, cb) => { live.sent.push({ id, text }); cb(null); },
  loginEnv: async () => ({}),
}));
vi.mock('../server/settings.js', () => ({ readSettings: () => settings }));
vi.mock('../server/transcript.js', () => ({ scanSessions: () => sessions }));
vi.mock('../server/ghClient.js', async (orig) => ({
  ...(await orig()),
  ghGraphql: async (query) => {
    const data = { viewer: { login: 'me' } };
    for (const m of query.matchAll(/(p\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g)) {
      data[m[1]] = { pullRequest: prs[`https://github.com/${m[2]}/${m[3]}/pull/${m[4]}`] || null };
    }
    return data;
  },
}));

const { watchReport, watchBaseline, watchMessage, toSnapshot, prWatchTick, watchPullRequest, unwatchPullRequest, listPrWatches, PR_WATCH_WAKE_LIMIT } = await import('../server/prWatch.js');

const URL1 = 'https://github.com/o/r/pull/1';

function pr({ head = 'a'.repeat(40), state = 'OPEN', mergeable = 'MERGEABLE', checks = [], comments = [], author = 'me' } = {}) {
  return {
    number: 1, url: URL1, state, mergeable, headRefOid: head, baseRefName: 'main', author: { login: author },
    head: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks.map(([name, conclusion]) => ({
      __typename: 'CheckRun', name, status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion, detailsUrl: `https://ci/${name}`,
    })) } } } }] },
    comments: { nodes: comments.map(([id, login, body]) => ({ id, author: { login }, body, createdAt: `2026-11-12T10:00:0${id.length}Z`, url: `https://c/${id}` })) },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
  };
}
const snap = (o) => toSnapshot(pr(o));
const T0 = Date.parse('2026-11-12T10:00:00Z');

describe('watchReport', () => {
  it('reports a new failure once, then passing checks once', () => {
    const base = watchBaseline(snap({ checks: [['build', null], ['lint', null]] }), T0);
    const r1 = watchReport(base, snap({ checks: [['build', 'FAILURE'], ['lint', null]] }), 'me', T0);
    expect(r1.changes).toEqual([{ kind: 'checks-failed', failed: [expect.objectContaining({ name: 'build', status: 'failed' })] }]);
    expect(watchReport(r1.next, snap({ checks: [['build', 'FAILURE'], ['lint', 'SUCCESS']] }), 'me', T0).changes).toEqual([]);
    const pushed = watchReport(r1.next, snap({ head: 'b'.repeat(40), checks: [['build', 'SUCCESS'], ['lint', 'SUCCESS']] }), 'me', T0);
    expect(pushed.changes).toEqual([{ kind: 'checks-passed', count: 2 }]);
    expect(watchReport(pushed.next, snap({ head: 'b'.repeat(40), checks: [['build', 'SUCCESS'], ['lint', 'SUCCESS']] }), 'me', T0).changes).toEqual([]);
  });

  it('tells about a missing check 15 minutes after a push, once', () => {
    const base = watchBaseline(snap({ checks: [['build', 'SUCCESS']] }), T0);
    const pushed = watchReport(base, snap({ head: 'c'.repeat(40) }), 'me', T0);
    expect(pushed.changes).toEqual([]);
    const later = watchReport(pushed.next, snap({ head: 'c'.repeat(40) }), 'me', T0 + 15 * 60_000);
    expect(later.changes).toEqual([{ kind: 'no-checks', minutes: 15 }]);
    expect(watchReport(later.next, snap({ head: 'c'.repeat(40) }), 'me', T0 + 30 * 60_000).changes).toEqual([]);
  });

  it('reports a conflict once, and again only after it was resolved', () => {
    const base = watchBaseline(snap(), T0);
    const c1 = watchReport(base, snap({ mergeable: 'CONFLICTING' }), 'me', T0);
    expect(c1.changes).toEqual([{ kind: 'conflicting' }]);
    const unknown = watchReport(c1.next, snap({ mergeable: 'UNKNOWN' }), 'me', T0);
    expect(unknown.changes).toEqual([]);
    const clean = watchReport(unknown.next, snap({ mergeable: 'MERGEABLE' }), 'me', T0);
    expect(watchReport(clean.next, snap({ mergeable: 'CONFLICTING' }), 'me', T0).changes).toEqual([{ kind: 'conflicting' }]);
  });

  it('reports comments from others, not from the viewer, and stops after the comment-only limit', () => {
    let state = watchBaseline(snap({ comments: [['x', 'bob', 'old']] }), T0);
    const r = watchReport(state, snap({ comments: [['x', 'bob', 'old'], ['y', 'me', 'mine'], ['zz', 'bot[bot]', 'hello']] }), 'me', T0);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].remarks.map((c) => c.id)).toEqual(['zz']);
    const comments = [];
    for (let i = 0; i < PR_WATCH_WAKE_LIMIT; i++) {
      comments.push([`c${i}`, 'bot[bot]', `ping ${i}`]);
      const rep = watchReport(state, snap({ comments }), 'me', T0);
      expect(rep.changes).toHaveLength(1);
      if (i < PR_WATCH_WAKE_LIMIT - 1) state = rep.next;
      else expect(rep).toMatchObject({ exhausted: true, next: null });
    }
  });

  it('ends the watch when the PR is merged', () => {
    expect(watchReport(watchBaseline(snap(), T0), snap({ state: 'MERGED' }), 'me', T0))
      .toEqual({ changes: [{ kind: 'merged' }], next: null, exhausted: false });
  });
});

describe('watchMessage', () => {
  it('lists the news and says how to stop', () => {
    const s = snap({ checks: [['build', 'FAILURE']] });
    const report = { changes: [{ kind: 'checks-failed', failed: s.checks }, { kind: 'remarks', remarks: [{ author: 'bob', path: 'a.js', text: 'x'.repeat(300), url: 'u' }] }], next: {}, exhausted: false };
    const text = watchMessage([{ snap: s, report }]);
    expect(text).toContain(`Update on pull request #1 (${URL1})`);
    expect(text).toContain('- Checks failed on aaaaaaa:\n  - build (https://ci/build)');
    expect(text).toContain(`  - @bob on a.js: "${'x'.repeat(200)}…" (u)`);
    expect(text).toMatch(/unwatch_pull_request to stop\.$/);
  });
});

describe('prWatchTick', () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    live.alive = new Set(['s1']);
    live.busy = new Set();
    live.sent = [];
    settings = { autoPrWatch: false };
    sessions = [];
    prs = { [URL1]: pr({ checks: [['build', null]] }) };
  });

  it('wakes an idle session, holds the news while it works', async () => {
    await watchPullRequest('s1', URL1);
    expect(listPrWatches('s1')).toEqual([URL1]);
    prs[URL1] = pr({ checks: [['build', 'FAILURE']] });
    live.busy.add('s1');
    await prWatchTick();
    expect(live.sent).toEqual([]);
    live.busy.clear();
    await prWatchTick();
    expect(live.sent).toHaveLength(1);
    expect(live.sent[0].text).toContain('Checks failed');
    await prWatchTick();
    expect(live.sent).toHaveLength(1);
  });

  it('keys a watch on the canonical PR url', async () => {
    await expect(watchPullRequest('s1', `${URL1}/files`)).resolves.toEqual({ url: URL1, number: 1 });
    expect(listPrWatches('s1')).toEqual([URL1]);
  });

  it('drops the watch once the PR is merged', async () => {
    await watchPullRequest('s1', URL1);
    prs[URL1] = pr({ state: 'MERGED' });
    await prWatchTick();
    expect(live.sent[0].text).toContain('It was merged');
    expect(listPrWatches('s1')).toEqual([]);
  });

  it('auto-watches only an open PR of the viewer, and not again after an unwatch', async () => {
    settings = { autoPrWatch: true };
    sessions = [{ id: 's1', prLinks: [URL1] }];
    prs[URL1] = pr({ author: 'someone-else' });
    await prWatchTick();
    expect(listPrWatches('s1')).toEqual([]);
    fs.rmSync(TMP, { recursive: true, force: true });
    prs[URL1] = pr();
    await prWatchTick();
    expect(listPrWatches('s1')).toEqual([URL1]);
    expect(unwatchPullRequest('s1')).toEqual([URL1]);
    await prWatchTick();
    expect(listPrWatches('s1')).toEqual([]);
  });

  it('refuses a session hooked does not drive, and a closed PR', async () => {
    await expect(watchPullRequest('nobody', URL1)).rejects.toThrow(/driven by hooked/);
    prs[URL1] = pr({ state: 'CLOSED' });
    await expect(watchPullRequest('s1', URL1)).rejects.toThrow(/closed/);
  });
});
