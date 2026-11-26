import { json } from '@sveltejs/kit';
import { profilesOverview, addAccountProfile } from '#lib/server/core.js';
import { fail, readJson } from '#lib/server/respond.js';

// The connection profiles from profiles.json (the implicit `default` first), without their env: no
// token, and no reference to one, ever leaves the server. `errors` lists the entries that were skipped.
export function GET() {
  return json(profilesOverview());
}

// `add-account`: a new profile with a Claude account of its own, its directory managed by hooked.
// The caller then signs it in through /api/account with the profile's id.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || body.action !== 'add-account') return fail(400, 'unknown action');
  const r = addAccountProfile(body.label);
  return r.error ? fail(400, r.error) : json({ ok: true, profile: r.profile });
}
