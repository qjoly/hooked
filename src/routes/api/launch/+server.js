import { launchSession } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'requête invalide');
  const { err, info } = await toPromise((cb) => launchSession(body, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
