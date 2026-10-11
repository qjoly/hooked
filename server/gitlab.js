import { execFile } from 'node:child_process';
import { loginEnv } from './agent.js';
import { splitPatch, isBotLogin } from './github.js';

// GitLab merge requests and issues, through `glab api`, mapped onto the shapes `gh` produces so the
// pills, the Links card and GhDetail render them unchanged. Any host: self-managed instances share
// the `/-/` route separator. Newer GitLab links issues as `/-/work_items/N`, same iid.
const GL_URL = /^https?:\/\/([^/]+)\/(.+?)\/-\/(merge_requests|issues|work_items)\/(\d+)/;

export function parseGitlabUrl(url) {
  const m = GL_URL.exec(String(url || ''));
  if (!m) return null;
  const kind = m[3] === 'merge_requests' ? 'pr' : 'issue';
  return { host: m[1], kind, base: `projects/${encodeURIComponent(m[2])}/${kind === 'pr' ? 'merge_requests' : 'issues'}/${m[4]}` };
}

// execFile resolves the binary through env.PATH, so the login PATH finds a brew glab under launchd.
async function glab(host, apiPath, { raw = false } = {}) {
  const env = await loginEnv();
  return new Promise((resolve, reject) => {
    execFile('glab', ['api', '--hostname', host, apiPath], { env, timeout: 30_000, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n')[0]));
      if (raw) return resolve(stdout);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

const STATE = { opened: 'OPEN', merged: 'MERGED', closed: 'CLOSED', locked: 'CLOSED' };
const stateOf = (d) => STATE[d.state] || String(d.state || '').toUpperCase();

// approved_by stays empty when no approval rule exists: `approved` alone would read as always approved.
async function decisionOf(host, base, d) {
  if (d.detailed_merge_status === 'requested_changes') return 'CHANGES_REQUESTED';
  const a = await glab(host, `${base}/approvals`).catch(() => null);
  if (a?.approved_by?.length) return 'APPROVED';
  return a?.approvals_left > 0 ? 'REVIEW_REQUIRED' : '';
}

// Same contract as ghView's fetch: null when glab is missing, unauthenticated or the URL is unknown.
export async function glabView(url) {
  const u = parseGitlabUrl(url);
  if (!u) return null;
  try {
    const d = await glab(u.host, u.base);
    return {
      kind: u.kind, number: d.iid, title: d.title, state: stateOf(d), author: d.author?.username || '',
      body: (d.description || '').slice(0, 4000),
      reviewDecision: u.kind === 'pr' ? await decisionOf(u.host, u.base, d) : '',
    };
  } catch { return null; }
}

const JOB_STATUS = { success: 'passed', failed: 'failed', canceled: 'cancelled', skipped: 'skipped', manual: 'neutral' };
export const toJob = (j) => ({
  name: j.name,
  workflow: j.stage || '',
  status: j.status === 'failed' && j.allow_failure ? 'neutral' : JOB_STATUS[j.status] || 'pending',
  url: j.web_url || '',
});

export function filesFromPatches(patches) {
  return Object.entries(patches).map(([path, p]) => {
    let additions = 0, deletions = 0, hunk = false;
    for (const l of p.split('\n')) {
      if (l.startsWith('@@')) hunk = true;
      else if (hunk && l[0] === '+') additions++;
      else if (hunk && l[0] === '-') deletions++;
    }
    const change = /^new file mode/m.test(p) ? 'ADDED' : /^deleted file mode/m.test(p) ? 'DELETED'
      : /^rename from/m.test(p) ? 'RENAMED' : 'MODIFIED';
    return { path, additions, deletions, change };
  });
}

const SYSTEM_REVIEW = [[/^approved this merge request/, 'APPROVED'], [/^requested changes/, 'CHANGES_REQUESTED']];

export function toNotes(notes, webUrl) {
  const comments = [];
  const reviews = [];
  for (const n of notes || []) {
    const author = n.author?.username || '';
    if (!n.system) {
      comments.push({ author, avatar: n.author?.avatar_url || '', bot: !!n.author?.bot || isBotLogin(author),
        body: n.body || '', at: n.created_at, url: `${webUrl}#note_${n.id}` });
      continue;
    }
    const hit = SYSTEM_REVIEW.find(([re]) => re.test(n.body || ''));
    if (hit) reviews.push({ kind: 'review', at: n.created_at, author, state: hit[1], text: '' });
  }
  return { comments, reviews };
}

export async function gitlabDetail(url) {
  const u = parseGitlabUrl(url);
  if (!u) throw new Error('Not a GitLab merge request or issue URL');
  const get = (p) => glab(u.host, p);
  // per_page=100 caps both lists; past that the tail is missing.
  const notesP = get(`${u.base}/notes?sort=asc&per_page=100`);

  if (u.kind === 'issue') {
    const [d, notes] = await Promise.all([get(`${u.base}?with_labels_details=true`), notesP]);
    const { comments } = toNotes(notes, d.web_url);
    return {
      kind: 'issue', number: d.iid, title: d.title, url: d.web_url, state: stateOf(d),
      author: d.author?.username || '', authorAvatar: d.author?.avatar_url || '',
      createdAt: d.created_at, updatedAt: d.updated_at, body: d.description || '',
      labels: (d.labels || []).map((l) => (typeof l === 'string' ? { name: l, color: '' } : { name: l.name, color: String(l.color || '').replace('#', '') })),
      assignees: (d.assignees || []).map((a) => a.username),
      comments,
      timeline: comments.map((c) => ({ kind: 'comment', ...c, text: c.body })),
    };
  }

  // ponytail: raw_diffs needs GitLab 17.6+; an older instance just gets an empty Code tab.
  const [d, notes, commits, raw] = await Promise.all([
    get(u.base), notesP, get(`${u.base}/commits?per_page=100`),
    glab(u.host, `${u.base}/raw_diffs`, { raw: true }).catch(() => ''),
  ]);
  const [jobs, decision] = await Promise.all([
    d.head_pipeline ? get(`projects/${d.project_id}/pipelines/${d.head_pipeline.id}/jobs?per_page=100`).catch(() => []) : [],
    decisionOf(u.host, u.base, d),
  ]);
  const files = filesFromPatches(splitPatch(raw));
  const { comments, reviews } = toNotes(notes, d.web_url);
  const timeline = [
    ...(commits || []).map((c) => ({ kind: 'commit', at: c.created_at, author: c.author_name || '', sha: c.short_id || '', text: c.title || '' })),
    ...reviews,
    ...comments.map((c) => ({ kind: 'comment', ...c, text: c.body })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  return {
    kind: 'pr', number: d.iid, title: d.title, url: d.web_url,
    state: d.draft && d.state === 'opened' ? 'DRAFT' : stateOf(d),
    author: d.author?.username || '', authorAvatar: d.author?.avatar_url || '',
    createdAt: d.created_at, updatedAt: d.updated_at,
    base: d.target_branch || '', head: d.source_branch || '',
    additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0),
    changedFiles: files.length,
    body: d.description || '', decision,
    checks: (jobs || []).map(toJob),
    comments, timeline, files,
  };
}

export async function gitlabDiff(url) {
  const u = parseGitlabUrl(url);
  if (u?.kind !== 'pr') throw new Error('Only merge requests have a diff');
  return splitPatch(await glab(u.host, `${u.base}/raw_diffs`, { raw: true }));
}
