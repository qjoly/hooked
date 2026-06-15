import { paneForSession, tmuxAlive, setModelEffort } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Change le modèle et/ou l'effort d'une session live en envoyant `/model` et `/effort`
// dans le TUI (comme au clavier), à la manière du changement de mode de permission.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'requête invalide');
  const { id, model, effort } = body;
  if (!id || (!model && !effort)) return fail(400, 'id et (modèle ou effort) requis');
  const pane = paneForSession(id);
  if (!pane || !tmuxAlive(pane)) return fail(409, 'aucun pane tmux vivant pour cette session');
  const { err, info } = await toPromise((cb) => setModelEffort(pane, { model, effort, sessionId: id }, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
