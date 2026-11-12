import fs from 'node:fs';
import path from 'node:path';
import { HOOKED_DIR } from './config.js';
import { readSettings } from './settings.js';
import { scanSessions } from './transcript.js';
import { agentAlive, agentBusy, agentPendingAsk, deliverReply } from './agent.js';
import { ghGraphql, parseItemUrl } from './ghClient.js';
import { headChecks } from './github.js';

// Design after T3 Code (MIT, pingdotgg/t3code): pullRequestWatch.ts.

const STORE_FILE = path.join(HOOKED_DIR, 'pr-watches.json');
const TICK_MS = parseInt(process.env.HOOKED_PR_WATCH_INTERVAL || '60000', 10) || 60000;
// Consecutive comment-only wakes before giving up, so two bots answering each other cannot loop.
export const PR_WATCH_WAKE_LIMIT = 10;
export const PR_WATCH_NO_CHECKS_MS = 15 * 60 * 1000;
const STALE_WATCH_MS = 7 * 24 * 60 * 60 * 1000;
const SEEN_CAP = 500;
const LISTED = 10;
const SNIPPET = 200;
const BATCH = 10;

const FRAGMENT = `fragment W on PullRequest {
  number url state mergeable headRefOid baseRefName author { login }
  head: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
    ... on StatusContext { context state targetUrl }
  } } } } } }
  comments(last: 20) { nodes { id author { login } body createdAt url } }
  reviews(last: 20) { nodes { id author { login } state body submittedAt url } }
  reviewThreads(last: 20) { nodes { path comments(last: 10) { nodes { id author { login } body createdAt url } } } }
}`;

const remark = (c, extra = {}) => ({
  id: c.id, author: c.author?.login || '', at: c.createdAt || c.submittedAt || '', url: c.url || '', text: c.body || '', ...extra,
});

export function toSnapshot(pr) {
  return {
    number: pr.number, url: pr.url, state: pr.state, mergeable: pr.mergeable,
    head: pr.headRefOid, base: pr.baseRefName, author: pr.author?.login || '',
    checks: headChecks(pr),
    remarks: [
      ...(pr.comments?.nodes || []).map((c) => remark(c)),
      ...(pr.reviews?.nodes || [])
        .filter((r) => r.body || r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
        .map((r) => remark(r, { review: r.state })),
      ...(pr.reviewThreads?.nodes || []).flatMap((t) => (t.comments?.nodes || []).map((c) => remark(c, { path: t.path }))),
    ].sort((a, b) => a.at.localeCompare(b.at)),
  };
}

async function fetchSnapshots(urls, { background }) {
  const refs = urls.map((url) => ({ url, ...parseItemUrl(url) }));
  const snaps = new Map();
  let viewer = '';
  for (let i = 0; i < refs.length; i += BATCH) {
    const chunk = refs.slice(i, i + BATCH);
    const parts = chunk.map((r, j) => `p${j}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.name)}) { pullRequest(number: ${r.number}) { ...W } }`);
    const data = await ghGraphql(`query { viewer { login } ${parts.join(' ')} } ${FRAGMENT}`, {}, { background, partial: true });
    viewer = data.viewer?.login || viewer;
    chunk.forEach((r, j) => {
      const pr = data[`p${j}`]?.pullRequest;
      if (pr) snaps.set(r.url, toSnapshot(pr));
    });
  }
  return { viewer, snaps };
}

export function watchBaseline(snap, now = Date.now()) {
  const settled = snap.checks.length > 0 && snap.checks.every((c) => c.status !== 'pending');
  return {
    head: snap.head,
    failed: snap.checks.filter((c) => c.status === 'failed').map((c) => c.name),
    passed: settled && !snap.checks.some((c) => c.status === 'failed'),
    awaitingSince: snap.checks.length ? null : now,
    noChecksTold: false,
    conflictTold: snap.mergeable === 'CONFLICTING',
    seen: snap.remarks.map((r) => r.id).slice(-SEEN_CAP),
    commentWakes: 0,
    touchedAt: now,
  };
}

/** What changed on a watched PR since `prev`, and the state to keep once the session was told. */
export function watchReport(prev, snap, viewer, now = Date.now()) {
  if (snap.state !== 'OPEN') {
    return { changes: [{ kind: snap.state === 'MERGED' ? 'merged' : 'closed' }], next: null, exhausted: false };
  }
  const next = { ...prev, touchedAt: now };
  if (snap.head !== prev.head) {
    Object.assign(next, { head: snap.head, failed: [], passed: false, awaitingSince: now, noChecksTold: false, conflictTold: false, commentWakes: 0 });
  }
  const changes = [];
  const failed = snap.checks.filter((c) => c.status === 'failed' && !next.failed.includes(c.name));
  if (failed.length) {
    changes.push({ kind: 'checks-failed', failed });
    next.failed = [...next.failed, ...failed.map((c) => c.name)];
  }
  const settled = snap.checks.length > 0 && snap.checks.every((c) => c.status !== 'pending');
  if (settled && !snap.checks.some((c) => c.status === 'failed') && !next.passed) {
    changes.push({ kind: 'checks-passed', count: snap.checks.length });
    next.passed = true;
  }
  if (snap.checks.length) next.awaitingSince = null;
  else if (next.awaitingSince && !next.noChecksTold && now - next.awaitingSince >= PR_WATCH_NO_CHECKS_MS) {
    changes.push({ kind: 'no-checks', minutes: Math.round(PR_WATCH_NO_CHECKS_MS / 60000) });
    next.noChecksTold = true;
  }
  // UNKNOWN is GitHub still computing after a push: only a clean answer clears a conflict.
  if (snap.mergeable === 'CONFLICTING' && !next.conflictTold) {
    changes.push({ kind: 'conflicting' });
    next.conflictTold = true;
  } else if (snap.mergeable === 'MERGEABLE') next.conflictTold = false;
  const seen = new Set(prev.seen);
  const remarks = snap.remarks.filter((r) => !seen.has(r.id) && r.author !== viewer);
  if (remarks.length) changes.push({ kind: 'remarks', remarks });
  next.seen = [...new Set([...prev.seen, ...snap.remarks.map((r) => r.id)])].slice(-SEEN_CAP);
  if (changes.length) next.commentWakes = changes.every((c) => c.kind === 'remarks') ? next.commentWakes + 1 : 0;
  const exhausted = next.commentWakes >= PR_WATCH_WAKE_LIMIT;
  return { changes, next: exhausted ? null : next, exhausted };
}

// Cut on code points: half an emoji would serialize to a lone surrogate.
const snippet = (text) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > SNIPPET ? `${chars.slice(0, SNIPPET).join('')}…` : flat;
};

const listed = (items, line) => [
  ...(items.length > LISTED ? [`  - ${items.length - LISTED} earlier not shown`] : []),
  ...items.slice(-LISTED).map(line),
];

function changeLines(change, snap) {
  const on = snap.head ? ` on ${snap.head.slice(0, 7)}` : '';
  switch (change.kind) {
    case 'checks-failed':
      return [`- Checks failed${on}:`, ...listed(change.failed, (c) => `  - ${c.workflow ? `${c.workflow} / ` : ''}${c.name}${c.url ? ` (${c.url})` : ''}`)];
    case 'checks-passed':
      return [`- All ${change.count} checks passed${on}.`];
    case 'no-checks':
      return [`- No check has reported${on} after ${change.minutes} minutes.`];
    case 'conflicting':
      return [`- It has a merge conflict with ${snap.base || 'its base branch'}.`];
    case 'remarks':
      return [`- New ${change.remarks.length === 1 ? 'comment' : `comments (${change.remarks.length})`}:`, ...listed(change.remarks, (r) => {
        const what = r.review === 'APPROVED' ? 'approved' : r.review === 'CHANGES_REQUESTED' ? 'requested changes' : '';
        const where = r.path ? ` on ${r.path}` : '';
        const text = snippet(r.text);
        return `  - @${r.author}${what ? ` ${what}` : ''}${where}${text ? `: "${text}"` : ''}${r.url ? ` (${r.url})` : ''}`;
      })];
    case 'merged':
      return ['- It was merged. hooked stopped watching it.'];
    case 'closed':
      return ['- It was closed. hooked stopped watching it.'];
    default:
      return [];
  }
}

const KEEP_WATCHING = 'hooked keeps watching and will message you about new check results, merge conflicts or comments. Call unwatch_pull_request to stop.';

export function watchMessage(items) {
  const blocks = items.map(({ snap, report }) => [
    `Update on pull request #${snap.number} (${snap.url}), which hooked is watching for you:`,
    ...report.changes.flatMap((c) => changeLines(c, snap)),
    ...(report.exhausted ? [`- hooked stopped watching after ${PR_WATCH_WAKE_LIMIT} comment-only updates in a row. Call watch_pull_request to watch it again.`] : []),
  ].join('\n'));
  const watching = items.some(({ report }) => report.next);
  return [...blocks, ...(watching ? [KEEP_WATCHING] : [])].join('\n\n');
}

function readStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return { sessions: s.sessions || {}, dismissed: s.dismissed || {} };
  } catch { return { sessions: {}, dismissed: {} }; }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

function dismiss(store, id, url) {
  const list = store.dismissed[id] || [];
  if (!list.includes(url)) store.dismissed[id] = [...list, url].slice(-50);
}

function removeWatch(store, id, url) {
  if (!store.sessions[id]) return;
  delete store.sessions[id][url];
  if (!Object.keys(store.sessions[id]).length) delete store.sessions[id];
}

function deliver(id, text) {
  return new Promise((resolve) => deliverReply(id, text, (err) => {
    if (err) console.warn(`[hooked] pr-watch: could not wake ${id}: ${err.message}`);
    resolve(!err);
  }));
}

function latestPrLink(id) {
  const s = scanSessions().find((x) => x.id === id);
  return (s?.prLinks || []).find((u) => parseItemUrl(u)?.kind === 'pr') || null;
}

export async function watchPullRequest(id, url) {
  if (!id || !agentAlive(id)) throw new Error('only a session driven by hooked can watch a pull request');
  const target = url || latestPrLink(id);
  if (parseItemUrl(target)?.kind !== 'pr') throw new Error(url ? 'not a GitHub pull request URL' : 'this session has no pull request link yet: pass its url');
  const { snaps } = await fetchSnapshots([target], { background: false });
  const snap = snaps.get(target);
  if (!snap) throw new Error('GitHub could not find this pull request');
  if (snap.state !== 'OPEN') throw new Error(`pull request #${snap.number} is ${snap.state.toLowerCase()}, there is nothing to watch`);
  const store = readStore();
  store.sessions[id] = { ...store.sessions[id], [snap.url]: watchBaseline(snap) };
  store.dismissed[id] = (store.dismissed[id] || []).filter((u) => u !== snap.url);
  writeStore(store);
  return { url: snap.url, number: snap.number };
}

export function unwatchPullRequest(id, url) {
  const store = readStore();
  const urls = url ? [url] : Object.keys(store.sessions[id] || {});
  const removed = urls.filter((u) => store.sessions[id]?.[u]);
  for (const u of urls) { removeWatch(store, id, u); dismiss(store, id, u); }
  writeStore(store);
  return removed;
}

export function listPrWatches(id) {
  return Object.keys(readStore().sessions[id] || {});
}

async function autoWatch() {
  const before = readStore();
  const candidates = scanSessions()
    .filter((s) => agentAlive(s.id))
    .map((s) => [s.id, (s.prLinks || []).find((u) => parseItemUrl(u)?.kind === 'pr')])
    .filter(([id, url]) => url && !before.sessions[id]?.[url] && !(before.dismissed[id] || []).includes(url));
  if (!candidates.length) return;
  const { viewer, snaps } = await fetchSnapshots([...new Set(candidates.map(([, url]) => url))], { background: true });
  const store = readStore();
  for (const [id, url] of candidates) {
    const snap = snaps.get(url);
    if (!snap || store.sessions[id]?.[url]) continue;
    if (snap.state === 'OPEN' && snap.author === viewer) store.sessions[id] = { ...store.sessions[id], [url]: watchBaseline(snap) };
    else dismiss(store, id, url);
  }
  writeStore(store);
}

export async function prWatchTick() {
  if (readSettings().autoPrWatch) await autoWatch();
  const store = readStore();
  const now = Date.now();
  const due = Object.entries(store.sessions).filter(([id]) => agentAlive(id));
  if (!due.length) return;
  const { viewer, snaps } = await fetchSnapshots([...new Set(due.flatMap(([, w]) => Object.keys(w)))], { background: true });
  const updates = [];
  for (const [id, watches] of due) {
    const items = [];
    const nexts = [];
    for (const [url, prev] of Object.entries(watches)) {
      const snap = snaps.get(url);
      if (!snap) continue;
      const report = watchReport(prev, snap, viewer, now);
      nexts.push([url, report.next]);
      if (report.changes.length) items.push({ snap, report });
    }
    if (items.length && (agentBusy(id) || agentPendingAsk(id))) continue;
    if (items.length && !(await deliver(id, watchMessage(items)))) continue;
    updates.push([id, nexts]);
  }
  const fresh = readStore();
  for (const [id, nexts] of updates) {
    for (const [url, next] of nexts) {
      if (!fresh.sessions[id]?.[url]) continue;
      if (next) fresh.sessions[id][url] = next;
      else { removeWatch(fresh, id, url); dismiss(fresh, id, url); }
    }
  }
  for (const [id, watches] of Object.entries(fresh.sessions)) {
    if (agentAlive(id)) continue;
    for (const [url, w] of Object.entries(watches)) if (now - (w.touchedAt || 0) > STALE_WATCH_MS) removeWatch(fresh, id, url);
  }
  writeStore(fresh);
}

function handle() {
  globalThis.__hookedPrWatch ??= { timer: null, running: false };
  return globalThis.__hookedPrWatch;
}

export function startPrWatch() {
  const h = handle();
  if (h.timer) return;
  h.timer = setInterval(() => {
    if (h.running) return;
    h.running = true;
    prWatchTick()
      .catch((e) => { if (e?.kind !== 'rate_limited') console.warn('[hooked] pr-watch tick error:', e?.message || e); })
      .finally(() => { h.running = false; });
  }, TICK_MS);
  h.timer.unref?.();
}
