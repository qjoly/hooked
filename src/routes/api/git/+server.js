import { json } from '@sveltejs/kit';
import { getGitStatus, listGitBranches, checkoutGitBranch, readGitSyncState, dismissRestartNotice } from '$lib/server/core.js';
import { fail, readJson, ok } from '$lib/server/respond.js';

// Git du dépôt DANS LEQUEL tourne le serveur hooked (résolu au runtime, cf. server/gitOps.js).
// GET  → branche courante + liste des branches + état de synchro (bannière restart).
// POST → { action: 'checkout', branch, strategy } | { action: 'dismiss-restart' }.
export async function GET() {
  const status = await getGitStatus();
  if (status.error) return fail(400, status.error);
  const branches = await listGitBranches(status.root);
  return json({ ...status, branches, sync: readGitSyncState() });
}

export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return fail(400, 'invalid request');
  const action = body.action;
  if (action === 'dismiss-restart') {
    return ok({ sync: dismissRestartNotice() });
  }
  if (action === 'checkout') {
    const res = await checkoutGitBranch(body.branch, body.strategy || 'block');
    if (res.ok) return json({ ok: true, status: res.status, stashRef: res.stashRef || null, note: res.note });
    // dirty en stratégie block : renvoyé 200 avec { dirty:true } → l'UI propose stash/force.
    if (res.dirty) return json({ ok: false, dirty: true, error: res.error });
    return fail(400, res.error || 'checkout failed');
  }
  return fail(400, 'unknown action');
}
