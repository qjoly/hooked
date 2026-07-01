import { showInPane } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Ouvre un pane/fenêtre tmux dans la session de `id` et y lance `command` (mirroir UI).
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const { err, info } = await toPromise((cb) => showInPane(body.id, { command: body.command, target: body.target }, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
