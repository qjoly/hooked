import { markNotificationsDone } from '../../../../../server/github.js';
import { ok, fail, readJson } from '$lib/server/respond.js';

// Body { ids: [threadId…] } → { ok, done: [threadId…], error }. A GitHub failure on some threads
// is reported in `error`, not thrown, so a throw here can only mean malformed ids.
export async function POST({ request }) {
  let result;
  try {
    result = await markNotificationsDone((await readJson(request))?.ids);
  } catch (e) {
    return fail(400, e.message);
  }
  const { done, error } = result;
  return done.length || !error ? ok({ done, error }) : fail(502, error);
}
