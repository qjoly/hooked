import { agentAlive, setMode } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Change le mode de permission de Claude (Normal / Auto / Plan). C'est une requête de contrôle de
// l'Agent SDK (Query.setPermissionMode) : un appel, une confirmation. Avant, il fallait cycler au
// clavier (Maj+Tab) en relisant le footer du TUI entre chaque frappe pour savoir où on en était.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const { id, mode } = body;
  if (!id || !mode) return fail(400, 'id and mode required');
  if (!agentAlive(id)) return fail(409, 'this session is not driven by hooked (ended, or started outside hooked)');
  const { err, info } = await toPromise((cb) => setMode(id, mode, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
