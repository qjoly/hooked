import { json } from '@sveltejs/kit';
import { buildUsage, findProfile } from '#lib/server/core.js';
import { fail } from '#lib/server/respond.js';

// The account gauges (5 h, 7 d, model-scoped). `?profile=<id>`: those of a profile that has an
// account of its own, instead of the default account's.
export function GET({ url }) {
  const profile = url.searchParams.get('profile') || null;
  if (profile && !findProfile(profile)) return fail(404, 'unknown profile');
  return json(buildUsage(profile));
}
