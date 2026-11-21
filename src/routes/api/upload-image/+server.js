import { saveImage } from '#lib/server/core.js';
import { ok, fail, toPromise } from '#lib/server/respond.js';

// image collée dans le composer : on l'écrit sur disque (machine locale) et on renvoie
// son chemin absolu, que le composer joindra au message (Claude Code lit l'image par chemin).
export async function POST({ request }) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    // adapter-node aborts the body stream past BODY_SIZE_LIMIT with a 413 SvelteKitError.
    if (e && e.status === 413) {
      return fail(413, 'image too large for the server request limit (BODY_SIZE_LIMIT, ' + (process.env.BODY_SIZE_LIMIT || '512K') + ')');
    }
    return fail(400, 'invalid request body');
  }
  const { err, info } = await toPromise((cb) => saveImage(body && body.dataUrl, cb));
  if (err) return fail(err.code === 400 ? 400 : 500, err.message || String(err));
  return ok(info);
}
