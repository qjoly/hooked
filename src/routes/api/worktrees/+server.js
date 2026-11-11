import { json } from '@sveltejs/kit';
import { listWorktrees, removeWorktree, worktreeLocation, scanSessions, agentAlive, liveSessionCwds } from '$lib/server/core.js';
import { ok, fail, readJson } from '$lib/server/respond.js';

export async function GET({ url }) {
  const sessions = scanSessions().map((s) => ({ id: s.id, project: s.project, live: agentAlive(s.id) }));
  const worktrees = await listWorktrees({
    projects: sessions.map((s) => s.project),
    sessions,
    withPr: url.searchParams.get('pr') !== '0',
  });
  return json({ location: worktreeLocation(), worktrees });
}

export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || body.action !== 'remove') return fail(400, 'unknown action');
  try {
    return ok(await removeWorktree(body.path, { force: body.force === true, liveCwds: liveSessionCwds() }));
  } catch (e) {
    if (e.dirty) return json({ ok: false, dirty: true, error: e.message });
    return fail(400, e.message || String(e));
  }
}
