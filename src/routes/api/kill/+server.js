import { killSession, closeAfterTurn } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// { launchKey } comes from a session archiving itself through MCP: it stops once its turn ends.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const id = body.id;
  if (!id && !body.launchKey) return fail(400, 'id required');
  const { err, info } = await toPromise((cb) => (id ? killSession(id, cb) : closeAfterTurn(body.launchKey, cb)));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
