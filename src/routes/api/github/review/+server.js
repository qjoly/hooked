import { reviewPrInSession } from '../../../../../server/prReview.js';
import { ok, fail, readJson } from '#lib/server/respond.js';

// Launches a session that reviews the pull request and reports in the conversation only.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body?.url) return fail(400, 'url required');
  try {
    return ok(await reviewPrInSession(body.url));
  } catch (e) {
    return fail(e.code === 400 ? 400 : 502, e.message || String(e));
  }
}
