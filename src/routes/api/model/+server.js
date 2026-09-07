import { agentAlive, setModelEffort } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Change le modèle et/ou l'effort d'une session live via les requêtes de contrôle du SDK
// (Query.setModel / Query.applyFlagSettings). Avant, il fallait taper `/model` et `/effort` dans le
// TUI puis confirmer le dialogue « la conversation va être relue » — sinon le changement ne
// s'appliquait pas.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const { id, model, effort } = body;
  if (!id || (!model && !effort)) return fail(400, 'id and (model or effort) required');
  if (!agentAlive(id)) return fail(409, 'this session is not driven by hooked (ended, or started outside hooked)');
  const { err, info } = await toPromise((cb) => setModelEffort(id, { model, effort }, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
