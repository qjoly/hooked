import { killPane } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Ferme un pane « show » (tue le pane tmux).
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'requête invalide');
  const { err, info } = await toPromise((cb) => killPane(body.pane, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
