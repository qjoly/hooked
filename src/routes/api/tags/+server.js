import { json } from '@sveltejs/kit';
import { readTags, setTags, writeTags } from '$lib/server/core.js';
import { fail, readJson } from '$lib/server/respond.js';

// Étiquettes de session persistées côté serveur (tags.json). GET renvoie { tags: { [id]: [] } }.
// POST accepte soit { id, tags } (remplace/efface les tags d'une session), soit { replace: map }
// (remplace toute la map — sert à la migration one-shot des tags localStorage historiques).
export function GET() {
  return json({ tags: readTags() });
}

export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return fail(400, 'invalid request');
  try {
    let tags;
    if (body.replace && typeof body.replace === 'object') tags = writeTags(body.replace);
    else if (typeof body.id === 'string') tags = setTags(body.id, Array.isArray(body.tags) ? body.tags : []);
    else return fail(400, 'invalid request');
    return json({ ok: true, tags });
  } catch (e) {
    return fail(500, e.message || String(e));
  }
}
