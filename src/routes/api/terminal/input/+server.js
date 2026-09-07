import { writeTerminal } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Frappes du navigateur → PTY, transmises TELLES QUELLES (Ctrl-C, flèches, Échap…) : c'est le shell
// et l'application qui les interprètent. L'écho revient par le flux SSE, pas par cette réponse.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const { err, info } = await toPromise((cb) => writeTerminal(body.id, body.data, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
