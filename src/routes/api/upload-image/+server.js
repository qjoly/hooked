import { saveImage } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// image collée dans le composer : on l'écrit sur disque (machine locale) et on renvoie
// son chemin absolu, que le composer joindra au message (Claude Code lit l'image par chemin).
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'requête invalide (image trop lourde ?)');
  const { err, info } = await toPromise((cb) => saveImage(body.dataUrl, cb));
  if (err) return fail(err.code === 400 ? 400 : 500, err.message || String(err));
  return ok(info);
}
