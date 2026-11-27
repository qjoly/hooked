import { json } from '@sveltejs/kit';
import { findProfile, fetchProfileModels, loginEnv } from '#lib/server/core.js';
import { fail } from '#lib/server/respond.js';

// The models a compatible profile's server offers (its /v1/models), for the pickers of a profile
// that does not list its own. `error` explains an empty list (server down, wrong URL…).
export async function GET({ url }) {
  const profile = findProfile(url.searchParams.get('profile'));
  if (!profile) return fail(404, 'unknown profile');
  return json(await fetchProfileModels(profile, await loginEnv()));
}
