import { paneForSession, tmuxAlive, setMode } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Change le mode de permission de Claude (Normal / Auto-edits / Plan) dans la session
// interactive en simulant des Maj+Tab, comme au clavier dans le TUI.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'requête invalide');
  const { id, mode } = body;
  if (!id || !mode) return fail(400, 'id et mode requis');
  const pane = paneForSession(id);
  if (!pane || !tmuxAlive(pane)) return fail(409, 'aucun pane tmux vivant pour cette session');
  // boucle fermée : setMode lit le mode réel à l'écran et envoie des Maj+Tab jusqu'à la cible.
  const { err, info } = await toPromise((cb) => setMode(pane, mode, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
