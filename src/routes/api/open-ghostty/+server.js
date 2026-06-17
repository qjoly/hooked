import { openInGhostty } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Ouvre la session dans Ghostty (attache le tmux vivant, sinon le dossier projet).
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'requête invalide');
  const id = body.id;
  if (!id) return fail(400, 'id requis');
  const { err, info } = await toPromise((cb) => openInGhostty(id, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
