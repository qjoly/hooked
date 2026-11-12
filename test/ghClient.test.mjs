import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../server/agent.js', () => ({ loginEnv: async () => ({ GITHUB_TOKEN: 'tok' }) }));

const {
  ghRest, ghGraphql, isRateLimited, retryAtFrom, quotaFromHeaders, cooldownMs, parseItemUrl, parseGithubRemote,
} = await import('../server/ghClient.js');

const STATE = Symbol.for('hooked.gh.client');

function answer(status, body = '', headers = {}) {
  return new Response(status === 304 || status === 204 ? null : (typeof body === 'string' ? body : JSON.stringify(body)), { status, headers });
}

let calls;
function route(handler) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const call = { url: String(url), init, headers: init.headers };
    calls.push(call);
    return handler(call, calls.length);
  }));
}

beforeEach(() => { delete globalThis[STATE]; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('rate-limit rules', () => {
  it('recognises a limit by status, quota header, body or GraphQL error type', () => {
    expect(isRateLimited({ status: 429, headers: {} })).toBe(true);
    expect(isRateLimited({ status: 403, headers: { 'x-ratelimit-remaining': '0' } })).toBe(true);
    expect(isRateLimited({ status: 403, headers: {}, body: 'You have exceeded a secondary rate limit' })).toBe(true);
    expect(isRateLimited({ status: 403, headers: {}, body: 'Resource not accessible by integration' })).toBe(false);
    expect(isRateLimited({ status: 200, headers: {}, graphqlErrors: [{ type: 'RATE_LIMITED' }] })).toBe(true);
    expect(isRateLimited({ status: 200, headers: {}, graphqlErrors: [{ type: 'NOT_FOUND' }] })).toBe(false);
  });

  it('reads the retry time from Retry-After, then the quota reset', () => {
    expect(retryAtFrom({ 'retry-after': '30' }, 1000)).toBe(31_000);
    expect(retryAtFrom({ 'x-ratelimit-reset': '50' }, 1000)).toBe(50_000);
    expect(retryAtFrom({}, 1000)).toBeUndefined();
  });

  it('parses quota headers and backs off exponentially up to 15 min', () => {
    expect(quotaFromHeaders({ 'x-ratelimit-resource': 'core', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': '10' }))
      .toEqual({ resource: 'core', limit: 5000, remaining: 12, resetAt: 10_000 });
    expect(quotaFromHeaders({ 'x-ratelimit-limit': '5000' })).toBeNull();
    expect([1, 2, 3, 10].map(cooldownMs)).toEqual([30_000, 60_000, 120_000, 900_000]);
  });
});

describe('url parsing', () => {
  it('recognises PR and issue links only', () => {
    expect(parseItemUrl('https://github.com/o/r.js/pull/12#discussion')).toEqual({ owner: 'o', name: 'r.js', kind: 'pr', number: 12 });
    expect(parseItemUrl('https://github.com/o/r/issues/3')).toMatchObject({ kind: 'issue', number: 3 });
    expect(parseItemUrl('https://github.com/o/r/pull/')).toBeNull();
    expect(parseItemUrl('https://github.com/o/r/pull/1x')).toBeNull();
  });

  it('reads the repository of a GitHub remote', () => {
    for (const remote of ['git@github.com:o/r.git', 'https://github.com/o/r', 'ssh://git@github.com/o/r.git', 'https://x@github.com/o/r.git']) {
      expect(parseGithubRemote(remote)).toEqual({ owner: 'o', name: 'r' });
    }
    expect(parseGithubRemote('git@gitlab.com:o/r.git')).toBeNull();
  });
});

describe('ghRest', () => {
  it('sends the token and API version, and revalidates with the ETag', async () => {
    route((call, n) => (n === 1 ? answer(200, { a: 1 }, { etag: '"v1"' }) : answer(304)));
    expect(await ghRest('notifications', { etag: true })).toEqual({ a: 1 });
    expect(calls[0].headers).toMatchObject({ authorization: 'Bearer tok', 'x-github-api-version': '2022-11-28' });
    expect(await ghRest('notifications', { etag: true })).toEqual({ a: 1 });
    expect(calls[1].headers['if-none-match']).toBe('"v1"');
  });

  it('drops the token when a redirect leaves the API origin', async () => {
    route((call, n) => (n === 1
      ? answer(302, '', { location: 'https://blob.example.com/log' })
      : answer(200, 'log text')));
    expect(await ghRest('repos/o/r/actions/jobs/1/logs', { raw: true })).toBe('log text');
    expect(calls[1].url).toBe('https://blob.example.com/log');
    expect(calls[1].headers.authorization).toBeUndefined();
  });

  it('pauses background reads after a limit, while interactive calls still go out', async () => {
    route((call, n) => (n === 1 ? answer(429, '{"message":"slow down"}', { 'retry-after': '60' }) : answer(200, {})));
    await expect(ghRest('x')).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(ghRest('x', { background: true })).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(calls).toHaveLength(1);
    await expect(ghRest('x')).resolves.toEqual({});
  });

  it('keeps the last 10% of the quota for interactive calls', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    route(() => answer(200, {}, { 'x-ratelimit-resource': 'core', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '400', 'x-ratelimit-reset': reset }));
    await ghRest('x');
    await expect(ghRest('x', { background: true })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(ghRest('x')).resolves.toEqual({});
  });

  it('maps 401 and 404 to typed errors', async () => {
    route((call, n) => (n === 1 ? answer(401, '{"message":"Bad credentials"}') : answer(404, '{"message":"Not Found"}')));
    await expect(ghRest('x')).rejects.toMatchObject({ kind: 'auth' });
    await expect(ghRest('x')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('never runs more than 8 requests at once', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return answer(200, {});
    }));
    await Promise.all(Array.from({ length: 30 }, () => ghRest('x')));
    expect(peak).toBe(8);
  });
});

describe('ghGraphql', () => {
  it('treats an HTTP 200 RATE_LIMITED answer as a limit', async () => {
    route(() => answer(200, { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }));
    await expect(ghGraphql('query { viewer { login } }')).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('fails a missing node unless the call accepts a partial answer', async () => {
    const body = { data: { i0: null, i1: { pullRequest: { number: 2 } } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] };
    route(() => answer(200, body));
    await expect(ghGraphql('q')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(ghGraphql('q', {}, { partial: true })).resolves.toEqual(body.data);
    expect(JSON.parse(calls[0].init.body)).toEqual({ query: 'q', variables: {} });
  });
});
