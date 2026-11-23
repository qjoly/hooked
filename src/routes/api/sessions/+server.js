import { buildSessionsWarm, configuredProviders, providerList } from '#lib/server/core.js';
import { jsonWithEtag } from '#lib/server/respond.js';

export async function GET({ request }) {
  const sessions = await buildSessionsWarm();
  // `now` changes on every call: keep it out of the validator so an idle dashboard gets 304s.
  // `providers` / `providerList` too: they only change with the settings or an installed CLI (the
  // settings page refetches /api/providers after a change).
  return jsonWithEtag(request, {
    sessions,
    now: new Date().toISOString(),
    providers: configuredProviders(),
    providerList: providerList(),
  }, sessions);
}
