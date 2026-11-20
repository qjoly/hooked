import { buildSessionsWarm } from '#lib/server/core.js';
import { jsonWithEtag } from '#lib/server/respond.js';

export async function GET({ request }) {
  const sessions = await buildSessionsWarm();
  // `now` changes on every call: keep it out of the validator so an idle dashboard gets 304s.
  return jsonWithEtag(request, { sessions, now: new Date().toISOString() }, sessions);
}
