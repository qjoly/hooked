import fs from 'node:fs';
import path from 'node:path';
import { ghRest, ghGraphql } from '#server/ghClient.js';
import { HOOKED_DIR } from '#server/config.js';

// The GitHub extension's page: unread notifications, assigned issues, open PRs (authored / review
// requested), and the open PRs of one repo. Its caches live on globalThis, where the PR actions of
// the core (server/github.js: approve, close) find them to drop what they changed.

// statusCheckRollup is expensive: a 25-PR search page with it brushes GitHub's ~10 s gateway
// timeout (502). So the search only returns ids, and details are fetched in parallel chunks.
const CAP = 60;
const CHUNK = 10;
const TTL_MS = 90 * 1000;

const PR_FIELDS = `... on PullRequest {
  number title url isDraft updatedAt reviewDecision additions deletions
  repository { nameWithOwner }
  author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  latestReviews(first: 10) { nodes { author { login } state submittedAt url } }
  reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
  comments { totalCount }
}`;

export function toPr(n) {
  return {
    number: n.number,
    title: n.title,
    url: n.url,
    repo: n.repository?.nameWithOwner || '',
    author: n.author?.login || '',
    draft: !!n.isDraft,
    updatedAt: n.updatedAt,
    decision: n.reviewDecision || '',
    checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || '',
    additions: n.additions || 0,
    deletions: n.deletions || 0,
    comments: n.comments?.totalCount || 0,
    reviews: (n.latestReviews?.nodes || []).map((r) => ({
      author: r.author?.login || '', state: r.state, at: r.submittedAt, url: r.url,
    })),
    requested: (n.reviewRequests?.nodes || [])
      .map((r) => r.requestedReviewer?.login || r.requestedReviewer?.name).filter(Boolean),
  };
}

// Asking a list for the full PR fields is slow (seconds, sometimes a 502) while ids come back
// in under a second, and per-id lookups in small parallel chunks stay fast.
async function prsByIds(ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  const pages = await Promise.all(chunks.map((c) =>
    ghGraphql(`query($ids: [ID!]!) { nodes(ids: $ids) { ${PR_FIELDS} } }`, { ids: c }, { partial: true })));
  return pages.flatMap((p) => p.nodes.filter((n) => n?.number).map(toPr));
}

async function searchPrs(q) {
  const data = await ghGraphql(
    `query($q: String!) { search(query: $q, type: ISSUE, first: ${CAP}) { nodes { ... on PullRequest { id } } } }`, { q });
  return prsByIds(data.search.nodes.map((n) => n.id).filter(Boolean));
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const REPO_TTL_MS = 60 * 1000;
const repoCache = (globalThis[Symbol.for('hooked.github.repoPrs')] ??= new Map()); // repo -> { at, promise }

// Every open PR of one repository, whoever wrote it: the page's own columns only hold the
// viewer's PRs and direct review requests, so a selected repo would otherwise look empty.
export async function githubRepoPrs(repo, { refresh = false } = {}) {
  if (!REPO_RE.test(repo || '')) throw new Error('Expected a repository as owner/name');
  const hit = repoCache.get(repo);
  if (!refresh && hit && Date.now() - hit.at < REPO_TTL_MS) return hit.promise;
  const [owner, name] = repo.split('/');
  const promise = ghGraphql(`query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${CAP}, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { id } }
  } }`, { owner, name }).then(async (d) => {
    const list = d.repository?.pullRequests;
    if (!list) throw new Error(`Repository ${repo} not found`);
    return { repo, total: list.totalCount, prs: await prsByIds(list.nodes.map((n) => n.id)) };
  });
  repoCache.set(repo, { at: Date.now(), promise });
  promise.catch(() => { if (repoCache.get(repo)?.promise === promise) repoCache.delete(repo); });
  return promise;
}

// Notifications only carry the API URL of their subject; map it to the page a human opens.
export function htmlUrl(subjectUrl, repoUrl) {
  const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(pulls|issues|commits)\/([^/]+)$/.exec(subjectUrl || '');
  if (!m) return repoUrl || '';
  const kind = { pulls: 'pull', issues: 'issues', commits: 'commit' }[m[2]];
  return `https://github.com/${m[1]}/${kind}/${m[3]}`;
}

export function toNotification(n) {
  return {
    id: n.id,
    repo: n.repository?.full_name || '',
    title: n.subject?.title || '',
    type: n.subject?.type || '',
    reason: n.reason,
    updatedAt: n.updated_at,
    url: htmlUrl(n.subject?.url, n.repository?.html_url),
  };
}

export function toIssue(n) {
  return {
    number: n.number,
    title: n.title,
    url: n.url,
    repo: n.repository?.nameWithOwner || '',
    author: n.author?.login || '',
    updatedAt: n.updatedAt,
    comments: n.comments?.totalCount || 0,
    labels: (n.labels?.nodes || []).map((l) => ({ name: l.name, color: l.color })),
  };
}

async function searchIssues(q) {
  const data = await ghGraphql(`query($q: String!) {
    search(query: $q, type: ISSUE, first: ${CAP}) { nodes { ... on Issue {
      number title url updatedAt repository { nameWithOwner } author { login }
      comments { totalCount } labels(first: 5) { nodes { name color } }
    } } } }`, { q });
  return data.search.nodes.filter((n) => n.number).map(toIssue);
}

// GitHub's search alone takes 2 to 5 s, so a cold overview can't be fast. The last one is kept
// in memory and on disk and served at once (stale-while-revalidate): the page paints the last
// state, then swaps in the fresh one. One fetch at a time; a refresh joins the one in flight.
const OVERVIEW_FILE = path.join(HOOKED_DIR, 'github-overview.json');
const OVERVIEW = Symbol.for('hooked.github.overview');
const ov = () => (globalThis[OVERVIEW] ??= { data: undefined, inflight: null });

async function fetchOverview() {
  const [viewer, notifs, issues, mine, review] = await Promise.all([
    ghRest('user', { etag: true }).then((u) => u.login || '', () => ''),
    ghRest('notifications?per_page=50', { etag: true }),
    searchIssues('is:issue is:open archived:false assignee:@me sort:updated-desc'),
    searchPrs('is:pr is:open archived:false author:@me sort:updated-desc'),
    // ponytail: direct requests only — team requests (review-requested:@me) are ~15x more and mostly bots.
    searchPrs('is:pr is:open archived:false user-review-requested:@me sort:updated-desc'),
  ]);
  return { fetchedAt: new Date().toISOString(), viewer, notifications: notifs.map(toNotification), issues, mine, review };
}

function readOverviewFile() {
  try { return JSON.parse(fs.readFileSync(OVERVIEW_FILE, 'utf8')); } catch { return null; }
}

function refreshOverview() {
  const s = ov();
  s.inflight ??= fetchOverview().then((data) => {
    s.data = data;
    try {
      fs.mkdirSync(HOOKED_DIR, { recursive: true });
      fs.writeFileSync(OVERVIEW_FILE + '.tmp', JSON.stringify(data));
      fs.renameSync(OVERVIEW_FILE + '.tmp', OVERVIEW_FILE);
    } catch { /* the memory copy is enough */ }
    return data;
  }).finally(() => { s.inflight = null; });
  return s.inflight;
}

export const isStale = (data, now = Date.now()) => !data?.fetchedAt || now - Date.parse(data.fetchedAt) > TTL_MS;

// `refresh` waits for fresh data. Otherwise the last overview comes back at once, flagged
// `stale` (with a refresh started behind it) when it is older than the TTL.
export async function githubOverview({ refresh = false } = {}) {
  const s = ov();
  if (s.data === undefined) s.data = readOverviewFile();
  if (refresh || !s.data) return { ...(await refreshOverview()), stale: false };
  const stale = isStale(s.data);
  if (stale) refreshOverview().catch(() => {});
  return { ...s.data, stale, refreshing: !!s.inflight };
}

// Marks notification threads as done, like the inbox's "Done" (which also marks them read).
// GitHub has no bulk "done", so it is one call per thread. A failed thread does not stop the
// others: the caller gets back the ids that went through, plus the first error.
export async function markNotificationsDone(ids) {
  if (!Array.isArray(ids) || !ids.every((id) => /^\d+$/.test(id))) {
    throw new Error('Expected a list of notification thread ids');
  }
  const done = [];
  let error = null;
  const results = await Promise.allSettled(ids.map((id) =>
    ghRest(`notifications/threads/${id}`, { method: 'DELETE', raw: true })));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') done.push(ids[i]);
    else error ??= r.reason.message;
  });
  // The cached overview would list them again on the next visit.
  const s = ov();
  if (done.length && s.data) {
    const gone = new Set(done);
    s.data = { ...s.data, notifications: s.data.notifications.filter((n) => !gone.has(n.id)) };
  }
  return { done, error };
}
