import { approvePr } from '../../../../../server/github.js';
import { ok, fail, readJson } from '#lib/server/respond.js';

export async function POST({ request }) {
  const body = await readJson(request);
  if (!body?.url) return fail(400, 'url required');
  try {
    return ok(await approvePr(body.url));
  } catch (e) {
    return fail(502, e.message || String(e));
  }
}
