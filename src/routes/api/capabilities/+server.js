import { json } from '@sveltejs/kit';
import { fetchModelGroups, fetchEfforts } from '$lib/server/core.js';

// Modèles (groupés par famille) & efforts proposés aux sélecteurs, dérivés LIVE du binaire claude
// installé (cf. server/capabilities.js) — mtime-caché côté serveur. Pas de claude → listes vides.
export function GET() {
  return json({ models: fetchModelGroups(), efforts: fetchEfforts() });
}
