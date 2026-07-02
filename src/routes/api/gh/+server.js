import { json } from '@sveltejs/kit';
import { ghView } from '../../../../server/ghMeta.js';

// Enrichissement d'un lien GitHub (PR ou issue) via `gh` : titre, état, auteur, description.
// Renvoie { data: null } quand gh est indisponible ou l'URL n'est pas reconnue (fallback gracieux).
export async function GET({ url }) {
  const data = await ghView(url.searchParams.get('url'));
  return json({ data });
}
