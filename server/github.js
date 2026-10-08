import { execFile } from 'node:child_process';
import { resolveGh } from './ghMeta.js';
import { loginEnv } from './agent.js';

// GitHub page: unread notifications, assigned issues, open PRs (authored / review requested).

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

// gh authenticates through GITHUB_TOKEN here, which only the login profile exports (cf. loginEnv).
async function gh(args) {
  const [bin, env] = await Promise.all([resolveGh(), loginEnv()]);
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout: 30_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n')[0]));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

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

async function searchPrs(q) {
  const { data } = await gh(['api', 'graphql', '-f', `q=${q}`, '-f',
    `query=query($q: String!) { search(query: $q, type: ISSUE, first: ${CAP}) { nodes { ... on PullRequest { id } } } }`]);
  const ids = data.search.nodes.map((n) => n.id).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  const pages = await Promise.all(chunks.map((c) =>
    gh(['api', 'graphql', '-f', `query={ nodes(ids: ${JSON.stringify(c)}) { ${PR_FIELDS} } }`])));
  return pages.flatMap((p) => p.data.nodes.filter((n) => n?.number).map(toPr));
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
  const { data } = await gh(['api', 'graphql', '-f', `q=${q}`, '-f', `query=query($q: String!) {
    search(query: $q, type: ISSUE, first: ${CAP}) { nodes { ... on Issue {
      number title url updatedAt repository { nameWithOwner } author { login }
      comments { totalCount } labels(first: 5) { nodes { name color } }
    } } } }`]);
  return data.search.nodes.filter((n) => n.number).map(toIssue);
}

let cache = null; // { at, promise }

async function fetchOverview() {
  const [notifs, issues, mine, review] = await Promise.all([
    gh(['api', 'notifications?per_page=50']),
    searchIssues('is:issue is:open archived:false assignee:@me sort:updated-desc'),
    searchPrs('is:pr is:open archived:false author:@me sort:updated-desc'),
    // ponytail: direct requests only — team requests (review-requested:@me) are ~15x more and mostly bots.
    searchPrs('is:pr is:open archived:false user-review-requested:@me sort:updated-desc'),
  ]);
  return { fetchedAt: new Date().toISOString(), notifications: notifs.map(toNotification), issues, mine, review };
}

export async function githubOverview({ refresh = false } = {}) {
  if (refresh || !cache || Date.now() - cache.at > TTL_MS) {
    const promise = fetchOverview();
    cache = { at: Date.now(), promise };
    promise.catch(() => { if (cache?.promise === promise) cache = null; });
  }
  return cache.promise;
}
