import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-gh-'));
const calls = { rest: 0, graphql: [] };

vi.mock('../../../server/config.js', () => ({ HOOKED_DIR: dir }));
vi.mock('../../../server/ghClient.js', () => ({
  parseItemUrl: () => null,
  ghRest: async () => { calls.rest++; return []; },
  ghGraphql: async (query, vars) => {
    calls.graphql.push(vars);
    if (query.includes('pullRequests(states: OPEN')) {
      return { repository: { pullRequests: { totalCount: 70, nodes: [{ id: 'a' }, { id: 'b' }] } } };
    }
    if (query.includes('nodes(ids:')) {
      return { nodes: vars.ids.map((id, i) => ({ number: i + 1, title: id, repository: { nameWithOwner: 'o/r' } })) };
    }
    return { search: { nodes: [] } };
  },
}));

const { githubOverview, githubRepoPrs, isStale } = await import('../server/github.js');
const FILE = path.join(dir, 'github-overview.json');

beforeEach(() => {
  calls.rest = 0;
  calls.graphql = [];
  delete globalThis[Symbol.for('hooked.github.overview')];
});

describe('github overview cache', () => {
  it('flags an overview older than the TTL as stale', () => {
    const now = Date.parse('2026-01-01T00:10:00Z');
    expect(isStale({ fetchedAt: '2026-01-01T00:09:00Z' }, now)).toBe(false);
    expect(isStale({ fetchedAt: '2026-01-01T00:05:00Z' }, now)).toBe(true);
    expect(isStale(null, now)).toBe(true);
  });

  it('serves the last overview from disk at once and refreshes it behind', async () => {
    fs.writeFileSync(FILE, JSON.stringify({ fetchedAt: '2020-01-01T00:00:00Z', notifications: [{ id: '1' }] }));
    const first = await githubOverview();
    expect(first).toMatchObject({ stale: true, notifications: [{ id: '1' }] });
    const fresh = await githubOverview({ refresh: true }); // joins the refresh started above
    expect(fresh.stale).toBe(false);
    expect(calls.rest).toBe(2); // viewer + notifications
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8')).notifications).toEqual([]);
  });

  it('waits for GitHub when nothing was ever fetched', async () => {
    fs.rmSync(FILE, { force: true });
    expect(await githubOverview()).toMatchObject({ stale: false, notifications: [] });
  });
});

describe('github repo pull requests', () => {
  it('lists every open PR of a repo through its ids', async () => {
    const r = await githubRepoPrs('o/r');
    expect(r).toMatchObject({ repo: 'o/r', total: 70 });
    expect(r.prs.map((p) => p.title)).toEqual(['a', 'b']);
  });

  it('refuses anything but owner/name', async () => {
    await expect(githubRepoPrs('o/r/../x')).rejects.toThrow(/owner\/name/);
    await expect(githubRepoPrs('')).rejects.toThrow(/owner\/name/);
  });
});
