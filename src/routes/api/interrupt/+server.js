import { paneForSession, tmuxAlive, sendKey } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Echap dans la session interactive : interrompt Claude (comme une frappe Echap au clavier).
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const id = body.id;
  if (!id) return fail(400, 'id required');
  const pane = paneForSession(id);
  if (!pane || !tmuxAlive(pane)) return fail(409, 'no live tmux pane for this session');
  const { err } = await toPromise((cb) => sendKey(pane, 'Escape', cb));
  if (err) return fail(502, 'tmux send-keys failed : ' + (err.message || err));
  return ok({ pane });
}
