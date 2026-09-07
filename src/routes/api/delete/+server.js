import { trashSession } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Met une session à la corbeille (déplace le transcript dans <projet>/bin/, récupérable).
// N.B. : ≠ /api/kill (qui termine le process de la session). Ici la session quitte le dashboard,
// sans perte.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const id = body.id;
  if (!id) return fail(400, 'id required');
  const { err, info } = await toPromise((cb) => trashSession(id, cb));
  if (err) return fail([400, 404].includes(err.code) ? err.code : 502, err.message || String(err));
  return ok(info);
}
