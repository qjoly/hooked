import { json } from '@sveltejs/kit';
import { readSettings, writeSettings } from '$lib/server/core.js';
import { fail, readJson } from '$lib/server/respond.js';

// Réglages persistants de hooked (settings.json côté serveur). GET renvoie l'objet complet
// (défauts inclus) ; POST fusionne un patch partiel, valide, persiste et renvoie le résultat.
export function GET() {
  return json(readSettings());
}

export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return fail(400, 'requête invalide');
  try {
    return json({ ok: true, settings: writeSettings(body) });
  } catch (e) {
    return fail(500, e.message || String(e));
  }
}
