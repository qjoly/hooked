import { json } from '@sveltejs/kit';
import { sessionByPane } from '$lib/server/core.js';

// Résout le pane tmux d'une session (son $TMUX_PANE) vers son détail hooked complet.
// C'est le seul point où une session peut découvrir son propre session_id / config :
// le pane est la seule identité qu'elle porte dans son environnement.
export function GET({ url }) {
  const pane = url.searchParams.get('pane');
  if (!pane) return json({ error: 'paramètre `pane` requis (ex. $TMUX_PANE)' }, { status: 400 });
  const d = sessionByPane(pane);
  if (!d) return json({ error: 'aucune session hooked connue pour ce pane', pane }, { status: 404 });
  return json(d);
}
