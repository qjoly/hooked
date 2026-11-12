/*
 * Automatic removal of the worktrees hooked created (settings → worktrees.cleanup). Two rules:
 * every session that used the worktree is archived, or nothing happened in it for N days.
 * Runs hourly, shortly after an archive, and on demand. Branches stay (removeWorktree only deletes
 * a merged one) and resuming a session checks its worktree out again (restoreWorktree).
 */
import fs from 'node:fs';
import { readSettings } from './settings.js';
import { scanSessions } from './transcript.js';
import { readSessionMeta, onSessionArchived } from './sessionMeta.js';
import { readWorktreeRegistry, removeWorktree, isInsidePath } from './worktrees.js';

const DAY_MS = 86_400_000;
const TICK_MS = 3_600_000;
// Leaves boot time to resumeDrivenSessions: until a session is resumed it does not count as live.
const FIRST_TICK_MS = 5 * 60_000;
// Archiving also kills the session; its worktree is only removable once the process is gone.
const AFTER_ARCHIVE_MS = 20_000;
const ORPHAN_GRACE_MS = 3_600_000;

const rulesEnabled = (rules) => !!rules && (rules.onArchive || rules.inactiveDays > 0);

function planWorktreeCleanup({ registry, sessions, meta, liveCwds, rules, now }) {
  if (!rulesEnabled(rules)) return [];
  const out = [];
  for (const [wtPath, e] of Object.entries(registry)) {
    if (!e || e.removedAt) continue;
    const users = sessions.filter((s) => s.project && isInsidePath(s.project, wtPath));
    const createdAt = Date.parse(e.createdAt) || 0;
    const lastActive = Math.max(createdAt, ...users.map((s) => Date.parse(s.lastTs) || 0));
    let reason = null;
    if (rules.onArchive && users.length && users.every((s) => meta[s.id]?.archived)) reason = 'archived';
    else if (rules.onArchive && !users.length && e.sessions?.length && now - createdAt > ORPHAN_GRACE_MS) reason = 'sessions deleted';
    else if (rules.inactiveDays > 0 && now - lastActive > rules.inactiveDays * DAY_MS) reason = `inactive for ${rules.inactiveDays} days`;
    if (!reason) continue;
    out.push({ path: wtPath, branch: e.branch || null, reason, live: liveCwds.some((c) => c && isInsidePath(c, wtPath)) });
  }
  return out;
}

async function runWorktreeCleanup({ rules, sessions, meta, liveCwds, now = Date.now() } = {}) {
  rules ??= readSettings().worktrees.cleanup;
  sessions ??= scanSessions();
  meta ??= readSessionMeta();
  liveCwds ??= (await import('./agent.js')).liveSessionCwds();
  const plan = planWorktreeCleanup({ registry: readWorktreeRegistry(), sessions, meta, liveCwds, rules, now });
  const report = { at: new Date(now).toISOString(), removed: [], kept: [], failed: [] };
  for (const { live, ...c } of plan) {
    if (!fs.existsSync(c.path)) continue;
    if (live) { report.kept.push({ ...c, why: 'a session is running in it' }); continue; }
    try {
      const r = await removeWorktree(c.path, { liveCwds });
      report.removed.push({ ...c, branch: r.branch || c.branch, branchDeleted: !!r.branchDeleted });
    } catch (e) {
      if (e.dirty) report.kept.push({ ...c, why: e.message });
      else report.failed.push({ ...c, error: e.message || String(e) });
    }
  }
  return report;
}

function handle() {
  globalThis.__hookedWorktreeCleanup ??= { timer: null, soon: null, running: null, last: null };
  return globalThis.__hookedWorktreeCleanup;
}

function cleanupWorktreesNow() {
  const h = handle();
  h.running ??= runWorktreeCleanup()
    .then((r) => {
      h.last = r;
      for (const x of r.removed) console.log(`[hooked] worktree cleanup: removed ${x.path} (${x.reason})`);
      for (const x of r.failed) console.warn(`[hooked] worktree cleanup: ${x.path}: ${x.error}`);
      return r;
    })
    .finally(() => { h.running = null; });
  return h.running;
}

function tick() {
  if (!rulesEnabled(readSettings().worktrees.cleanup)) return;
  cleanupWorktreesNow().catch((e) => console.warn('[hooked] worktree cleanup:', e?.message || e));
}

function scheduleWorktreeCleanup(delay = AFTER_ARCHIVE_MS) {
  const h = handle();
  clearTimeout(h.soon);
  h.soon = setTimeout(tick, delay);
  h.soon.unref?.();
}

function startWorktreeCleanup() {
  onSessionArchived('worktreeCleanup', () => {
    if (readSettings().worktrees.cleanup.onArchive) scheduleWorktreeCleanup();
  });
  const h = handle();
  if (h.timer) return;
  scheduleWorktreeCleanup(FIRST_TICK_MS);
  h.timer = setInterval(tick, TICK_MS);
  h.timer.unref?.();
}

const lastWorktreeCleanup = () => handle().last;

export { planWorktreeCleanup, runWorktreeCleanup, cleanupWorktreesNow, scheduleWorktreeCleanup, startWorktreeCleanup, lastWorktreeCleanup };
