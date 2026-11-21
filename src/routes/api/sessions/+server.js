import { buildSessionsWarm, configuredProviders } from '#lib/server/core.js';
import { jsonWithEtag } from '#lib/server/respond.js';

export async function GET({ request }) {
  const sessions = await buildSessionsWarm();
  // `now` changes on every call: keep it out of the validator so an idle dashboard gets 304s.
  // `providers` (comme `now`) hors validator ETag : ne change qu'à l'installation d'un CLI.
  return jsonWithEtag(request, { sessions, now: new Date().toISOString(), providers: configuredProviders() }, sessions);
}
