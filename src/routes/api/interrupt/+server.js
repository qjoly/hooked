import { agentAlive, interruptSession } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Interrompt Claude (l'équivalent d'Échap dans le TUI), via Query.interrupt(). Plus besoin
// d'effacer derrière : le TUI réinjectait le prompt annulé dans sa boîte de saisie et il fallait
// deux Échap pour le vider — ici la file d'entrée est la nôtre, rien n'est réinjecté.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const id = body.id;
  if (!id) return fail(400, 'id required');
  if (!agentAlive(id)) return fail(409, 'this session is not driven by hooked (ended, or started outside hooked)');
  const { err, info } = await toPromise((cb) => interruptSession(id, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
