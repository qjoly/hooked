import { json } from '@sveltejs/kit';
import { capturePane } from '$lib/server/core.js';
import { toPromise } from '$lib/server/respond.js';

// Mirroir lecture seule : capture l'écran courant d'un pane tmux (contenu + dimensions).
export async function GET({ url }) {
  const pane = url.searchParams.get('pane');
  const { err, info } = await toPromise((cb) => capturePane(pane, cb));
  if (err) return json({ ok: false, error: err.message || String(err) }, { status: err.code === 400 ? 400 : 502 });
  return json({ ok: true, ...info });
}
