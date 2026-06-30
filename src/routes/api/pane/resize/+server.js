import { resizePane } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Redimensionne la fenêtre tmux du pane pour remplir la vue web ({cols,rows}), ou restaure le
// dimensionnement auto ({auto:true}) quand la vue web se ferme.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'requête invalide');
  const { err, info } = await toPromise((cb) => resizePane(body.pane, body, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
