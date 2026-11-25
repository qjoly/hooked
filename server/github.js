/*
 * GitHub items linked from sessions: the detail of a PR or issue (Summary · Timeline · Code), its
 * diff, an Actions run and its job logs, and the actions on a PR (approve, close). The session dock
 * opens them on web, desktop and Android, whatever the GitHub module (modules/github) says; the
 * module's page lists PRs and notifications.
 */
import { ghRest, ghGraphql, parseItemUrl } from './ghClient.js';
import { parseRunUrl } from '../src/lib/ghRun.js';

// The GitHub module's page caches an approved or closed PR in its lists: drop them, so the next read
// fetches again. They live on globalThis (modules/github/server/github.js), so the core needs no
// import of the module, which may be off.
function dropPageCaches(repo) {
  globalThis[Symbol.for('hooked.github.repoPrs')]?.delete(repo);
  const s = globalThis[Symbol.for('hooked.github.overview')];
  if (s && s.data) s.data = { ...s.data, fetchedAt: '' };
}

// Approves a pull request as the signed-in user, like GitHub's "Approve" review with no body.
export async function approvePr(url) {
  const { owner, name, number, kind } = itemRef(url);
  if (kind !== 'pr') throw new Error('Only pull requests can be approved');
  const r = await ghRest(`repos/${owner}/${name}/pulls/${number}/reviews`, { method: 'POST', body: { event: 'APPROVE' } });
  dropPageCaches(`${owner}/${name}`); // the next read refreshes the review lists
  return { state: r.state, url: r.html_url };
}

// Closes a pull request without merging it (it can be reopened on GitHub).
export async function closePr(url) {
  const { owner, name, number, kind } = itemRef(url);
  if (kind !== 'pr') throw new Error('Only pull requests can be closed here');
  const r = await ghRest(`repos/${owner}/${name}/pulls/${number}`, { method: 'PATCH', body: { state: 'closed' } });
  dropPageCaches(`${owner}/${name}`); // the next read drops it from the lists
  return { state: r.state };
}

// ── Detail panel of a single PR / issue (Summary · Timeline · Code) ──

const CHECK_CONTEXTS = `contexts(first: 100) { nodes {
  __typename
  ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
  ... on StatusContext { context state targetUrl }
} }`;
const COMMENTS = 'comments(last: 100) { nodes { author { login } body createdAt url } }';
const FILES_PAGE = 'files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path additions deletions changeType } }';

const PR_DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    number title url state isDraft author { login } createdAt updatedAt mergedAt closedAt
    baseRefName headRefName additions deletions changedFiles body reviewDecision
    ${COMMENTS}
    reviews(last: 100) { nodes { author { login } state body submittedAt } }
    commits(last: 100) { nodes { commit { oid messageHeadline committedDate authors(first: 1) { nodes { name user { login } } } } } }
    head: commits(last: 1) { nodes { commit { statusCheckRollup { ${CHECK_CONTEXTS} } } } }
    ${FILES_PAGE}
  } }
}`;
const PR_FILES_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${FILES_PAGE} } }
}`;
const ISSUE_DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    number title url state stateReason author { login } createdAt updatedAt closedAt body
    labels(first: 20) { nodes { name color } }
    assignees(first: 20) { nodes { login } }
    ${COMMENTS}
  } }
}`;
// GitHub caps a pull request's file list at 3000.
const MAX_FILE_PAGES = 30;

// CheckRun carries status+conclusion, StatusContext a single state: both fold into one vocabulary.
const CHECK_STATUS = {
  SUCCESS: 'passed', FAILURE: 'failed', ERROR: 'failed', TIMED_OUT: 'failed', STARTUP_FAILURE: 'failed',
  ACTION_REQUIRED: 'failed', CANCELLED: 'cancelled', SKIPPED: 'skipped', STALE: 'skipped', NEUTRAL: 'neutral',
};
export function toCheck(c) {
  const raw = c.__typename === 'StatusContext' ? c.state : (c.status === 'COMPLETED' ? c.conclusion : 'PENDING');
  return {
    name: c.name || c.context || '',
    workflow: c.checkSuite?.workflowRun?.workflow?.name || '',
    status: CHECK_STATUS[raw] || 'pending',
    url: c.detailsUrl || c.targetUrl || '',
  };
}

export const headChecks = (pr) => (pr.head?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || []).map(toCheck);

// ponytail: a comment author has no is_bot flag here, so bots are guessed from the login.
export const isBotLogin = (login) => /\[bot\]$|^app\/|bot$|renovate|dependabot/i.test(login || '');

const toComment = (c) => ({
  author: c.author?.login || '', bot: isBotLogin(c.author?.login), body: c.body || '', at: c.createdAt, url: c.url || '',
});

export function toPrDetail(d) {
  const comments = (d.comments?.nodes || []).map(toComment);
  const timeline = [
    ...(d.commits?.nodes || []).map(({ commit: c }) => ({
      kind: 'commit', at: c.committedDate,
      author: c.authors?.nodes?.[0]?.user?.login || c.authors?.nodes?.[0]?.name || '',
      sha: (c.oid || '').slice(0, 7), text: c.messageHeadline || '',
    })),
    // An empty COMMENTED review is the wrapper GitHub creates around inline comments: noise here.
    ...(d.reviews?.nodes || []).filter((r) => r.state !== 'COMMENTED' || r.body).map((r) => ({
      kind: 'review', at: r.submittedAt, author: r.author?.login || '', state: r.state, text: r.body || '',
    })),
    ...comments.map((c) => ({ kind: 'comment', ...c, text: c.body })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return {
    kind: 'pr',
    number: d.number, title: d.title, url: d.url,
    state: d.isDraft && d.state === 'OPEN' ? 'DRAFT' : d.state,
    author: d.author?.login || '', createdAt: d.createdAt, updatedAt: d.updatedAt,
    base: d.baseRefName || '', head: d.headRefName || '',
    additions: d.additions || 0, deletions: d.deletions || 0, changedFiles: d.changedFiles || 0,
    body: d.body || '', decision: d.reviewDecision || '',
    checks: headChecks(d),
    comments, timeline,
    files: (d.files?.nodes || []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, change: f.changeType })),
  };
}

export function toIssueDetail(d) {
  const comments = (d.comments?.nodes || []).map(toComment);
  return {
    kind: 'issue',
    number: d.number, title: d.title, url: d.url,
    state: d.state === 'CLOSED' && d.stateReason === 'NOT_PLANNED' ? 'NOT_PLANNED' : d.state,
    author: d.author?.login || '', createdAt: d.createdAt, updatedAt: d.updatedAt,
    body: d.body || '',
    labels: (d.labels?.nodes || []).map((l) => ({ name: l.name, color: l.color })),
    assignees: (d.assignees?.nodes || []).map((a) => a.login),
    comments,
    timeline: comments.map((c) => ({ kind: 'comment', ...c, text: c.body })),
  };
}

function itemRef(url) {
  const ref = parseItemUrl(url);
  if (!ref) throw new Error('Not a GitHub pull request or issue URL');
  return ref;
}

export async function githubDetail(url) {
  const { owner, name, number, kind } = itemRef(url);
  const vars = { owner, name, number };
  if (kind === 'issue') {
    const data = await ghGraphql(ISSUE_DETAIL_QUERY, vars);
    return toIssueDetail(data.repository.issue);
  }
  const pr = (await ghGraphql(PR_DETAIL_QUERY, vars)).repository.pullRequest;
  const files = [...pr.files.nodes];
  let page = pr.files.pageInfo;
  for (let i = 1; page.hasNextPage && i < MAX_FILE_PAGES; i++) {
    const next = (await ghGraphql(PR_FILES_QUERY, { ...vars, after: page.endCursor })).repository.pullRequest.files;
    files.push(...next.nodes);
    page = next.pageInfo;
  }
  return toPrDetail({ ...pr, files: { nodes: files } });
}

// Unified patch split per file, keyed by the new path (the old one for a deletion).
export function splitPatch(text) {
  const out = {};
  for (const chunk of String(text || '').split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (m) out[/^\+\+\+ \/dev\/null$/m.test(chunk) ? m[1] : m[2]] = chunk.trimEnd();
  }
  return out;
}

export async function githubDiff(url) {
  const { owner, name, number, kind } = itemRef(url);
  if (kind !== 'pr') throw new Error('Only pull requests have a diff');
  return splitPatch(await ghRest(`repos/${owner}/${name}/pulls/${number}`,
    { accept: 'application/vnd.github.diff', raw: true, etag: true, timeout: 60_000 }));
}

// ── GitHub Actions run (live job/step status, logs of finished jobs) ──

// Runs, jobs and steps share the check vocabulary of the PR panel.
// A step that has not started yet may carry the zero date.
const when = (t) => (t && !t.startsWith('0001-') ? t : '');
const runStatus = (status, conclusion) =>
  status !== 'completed' ? 'pending' : CHECK_STATUS[String(conclusion || '').toUpperCase()] || 'neutral';

export function toRun(r, jobs = []) {
  return {
    title: r.display_title || r.name || '', workflow: r.name || '',
    status: runStatus(r.status, r.conclusion), url: r.html_url,
    branch: r.head_branch || '', event: r.event || '', attempt: r.run_attempt || 1,
    createdAt: r.created_at, updatedAt: r.updated_at,
    jobs: jobs.map((j) => ({
      id: String(j.id), name: j.name, url: j.html_url,
      status: runStatus(j.status, j.conclusion), startedAt: when(j.started_at), completedAt: when(j.completed_at),
      steps: (j.steps || []).map((s) => ({
        name: s.name, status: runStatus(s.status, s.conclusion), startedAt: when(s.started_at), completedAt: when(s.completed_at),
      })),
    })),
  };
}

function runRef(url) {
  const r = parseRunUrl(url);
  if (!r) throw new Error('Not a GitHub Actions run URL');
  return r;
}

export async function githubRun(url) {
  const { repo, run } = runRef(url);
  const [r, jobs] = await Promise.all([
    ghRest(`repos/${repo}/actions/runs/${run}`, { etag: true }),
    ghRest(`repos/${repo}/actions/runs/${run}/jobs?per_page=100`, { etag: true }),
  ]);
  return toRun(r, jobs.jobs);
}

// Drops the BOM, the per-line timestamps, ANSI colours and the group markers of the raw job log.
export function cleanJobLog(text) {
  return String(text || '').replace(/^﻿/, '').split('\n')
    .filter((l) => !l.includes('##[endgroup]'))
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace('##[group]', '▸ ').trimEnd())
    .join('\n').trimEnd();
}

// GitHub only serves a job's log once the job has finished (404 before that).
export async function githubJobLog(url) {
  const { repo, job } = runRef(url);
  if (!job) throw new Error('Not a GitHub Actions job URL');
  try {
    return { log: cleanJobLog(await ghRest(`repos/${repo}/actions/jobs/${job}/logs`, { raw: true, timeout: 60_000 })) };
  } catch (e) {
    if (e.kind === 'not_found') return { log: null };
    throw e;
  }
}
