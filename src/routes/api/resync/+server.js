import { clearPaneCaches, buildSessions } from '$lib/server/core.js';
import { ok } from '$lib/server/respond.js';

// Force a live-state resync. Drops the pane caches (tmux liveness + captured footer) so the rebuild
// re-reads every session from tmux at cold, then returns fresh state counts. Fixes a session stuck
// on a stale status (e.g. "working" after its tmux was closed) without waiting for the periodic poll.
export async function POST() {
  clearPaneCaches();
  const sessions = buildSessions();
  const counts = {};
  for (const s of sessions) counts[s.state] = (counts[s.state] || 0) + 1;
  return ok({ count: sessions.length, counts });
}
