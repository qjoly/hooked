import { json } from '@sveltejs/kit';
import { profilesOverview } from '#lib/server/core.js';

// The connection profiles from profiles.json (the implicit `default` first), without their env: no
// token, and no reference to one, ever leaves the server. `errors` lists the entries that were skipped.
export function GET() {
  return json(profilesOverview());
}
