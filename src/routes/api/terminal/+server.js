import { openTerminal, listTerminals } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// GET : terminaux ouverts (optionnellement ceux étiquetés d'une session).
export function GET({ url }) {
  const sessionId = url.searchParams.get('sessionId') || null;
  return ok({ terminals: listTerminals(sessionId) });
}

// POST : ouvre un shell dans `cwd`. `sessionId` n'est qu'une ÉTIQUETTE pour regrouper les terminaux
// d'un projet dans l'UI — le terminal ne parle pas à la session Claude et lui survit.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const { err, info } = await toPromise((cb) => openTerminal(body, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
