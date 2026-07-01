import { pickFolder } from '$lib/server/core.js';
import { ok, fail, toPromise, readJson } from '$lib/server/respond.js';

// Ouvre le sélecteur de dossier natif de l'OS et renvoie le chemin choisi ({ dir } ou { canceled }).
export async function POST({ request }) {
  const body = (await readJson(request)) || {};
  const { err, info } = await toPromise((cb) => pickFolder(body.start, cb));
  if (err) return fail(err.code === 400 ? 400 : 502, err.message || String(err));
  return ok(info);
}
