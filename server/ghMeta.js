import { glabView, parseGitlabUrl } from './gitlab.js';
import { ghGraphql, parseItemUrl } from './ghClient.js';

// Refresh cadence by activity, after T3 Code's PullRequestSyncReactor: a PR someone touched in the
// last half hour is re-read every minute, a quiet one every 5 min, a dormant one every 30 min. A
// MERGED/CLOSED item never changes again, so it is never re-read.
const ACTIVE_TTL_MS = 60 * 1000;
const QUIET_AFTER_MS = 30 * 60 * 1000;
const QUIET_TTL_MS = 5 * 60 * 1000;
const DORMANT_AFTER_MS = 24 * 60 * 60 * 1000;
const DORMANT_TTL_MS = 30 * 60 * 1000;
const MISSING_TTL_MS = 15 * 60 * 1000;
const ERROR_TTL_MS = 5 * 60 * 1000;
const TERMINAL_STATES = new Set(['MERGED', 'CLOSED']);
const BATCH = 20;

const CACHE = Symbol.for('hooked.gh.meta.cache');
const cache = (globalThis[CACHE] ??= new Map());

export function viewTtl(data, now = Date.now()) {
  if (!data) return MISSING_TTL_MS;
  if (TERMINAL_STATES.has(String(data.state).toUpperCase())) return Infinity;
  const quietFor = now - (Date.parse(data.updatedAt) || 0);
  if (quietFor < QUIET_AFTER_MS) return ACTIVE_TTL_MS;
  return quietFor < DORMANT_AFTER_MS ? QUIET_TTL_MS : DORMANT_TTL_MS;
}

const fresh = (hit, now) => hit && now - hit.at < hit.ttl;

const FRAGMENTS = {
  pr: 'fragment P on PullRequest { number title body state updatedAt reviewDecision author { login } }',
  issue: 'fragment I on Issue { number title body state updatedAt author { login } }',
};

// One request for many items: each is an alias, and a missing one only nulls its own alias.
export function batchQuery(refs) {
  const parts = refs.map((r, i) => `i${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.name)}) { `
    + `${r.kind === 'pr' ? 'pullRequest' : 'issue'}(number: ${r.number}) { ...${r.kind === 'pr' ? 'P' : 'I'} } }`);
  const kinds = [...new Set(refs.map((r) => r.kind))];
  return `query { ${parts.join(' ')} } ${kinds.map((k) => FRAGMENTS[k]).join(' ')}`;
}

export function toView(kind, d) {
  if (!d) return null;
  return {
    kind, number: d.number, title: d.title, state: d.state, updatedAt: d.updatedAt || '',
    author: d.author?.login || '', body: (d.body || '').slice(0, 4000), reviewDecision: d.reviewDecision || '',
  };
}

async function fetchGithub(urls, background) {
  const refs = urls.map((url) => ({ url, ...parseItemUrl(url) }));
  const out = new Map();
  for (let i = 0; i < refs.length; i += BATCH) {
    const chunk = refs.slice(i, i + BATCH);
    const data = await ghGraphql(batchQuery(chunk), {}, { background, partial: true });
    chunk.forEach((r, j) => {
      const repo = data[`i${j}`];
      out.set(r.url, toView(r.kind, r.kind === 'pr' ? repo?.pullRequest : repo?.issue));
    });
  }
  return out;
}

function store(url, data, now) {
  cache.set(url, { at: now, data, ttl: viewTtl(data, now) });
}

async function ghViewMany(urls, { background = false } = {}) {
  const now = Date.now();
  const result = new Map();
  const dueGithub = [];
  const dueGitlab = [];
  for (const url of new Set(urls.filter(Boolean).map(String))) {
    const hit = cache.get(url);
    if (fresh(hit, now)) result.set(url, hit.data);
    else if (parseItemUrl(url)) dueGithub.push(url);
    else if (parseGitlabUrl(url)) dueGitlab.push(url);
  }
  await Promise.all([
    dueGithub.length && fetchGithub(dueGithub, background).then(
      (fetched) => { for (const [url, data] of fetched) { store(url, data, now); result.set(url, data); } },
      () => {
        for (const url of dueGithub) {
          const data = cache.get(url)?.data ?? null;
          cache.set(url, { at: now, data, ttl: ERROR_TTL_MS });
          result.set(url, data);
        }
      }),
    ...dueGitlab.map(async (url) => {
      const data = await glabView(url);
      store(url, data, now);
      result.set(url, data);
    }),
  ]);
  return result;
}

async function ghView(url, opts) {
  if (!parseItemUrl(url) && !parseGitlabUrl(url)) return null;
  return (await ghViewMany([url], opts)).get(String(url)) ?? null;
}

export { ghView, ghViewMany };
