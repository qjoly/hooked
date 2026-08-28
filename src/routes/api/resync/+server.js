import { clearAgentState, buildSessions } from '$lib/server/core.js';
import { ok } from '$lib/server/respond.js';

// Force a live-state resync. Drops the volatile per-session bits derived from the SDK stream
// (current tool, follow-up suggestion) and rebuilds the list, then returns fresh state counts.
// Before the move off tmux this dropped the pane caches (liveness + captured footer) because state
// was scraped from the terminal with a 2.5s TTL; the registry is now in memory and always current,
// so this is mostly a "recompute now, don't wait for the 5s poll" button.
export async function POST() {
  clearAgentState();
  const sessions = buildSessions();
  const counts = {};
  for (const s of sessions) counts[s.state] = (counts[s.state] || 0) + 1;
  return ok({ count: sessions.length, counts });
}
