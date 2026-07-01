import { restoreSession } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Restaure une session depuis la corbeille (remonte le transcript hors de bin/).
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'requête invalide');
  if (!body.id) return fail(400, 'id requis');
  const { err, info } = await toPromise((cb) => restoreSession(body.id, cb));
  if (err) return fail([400, 404, 409].includes(err.code) ? err.code : 502, err.message || String(err));
  return ok(info);
}
