import { json } from '@sveltejs/kit';
import { sessionDetailWarm } from '$lib/server/core.js';

export async function GET({ url }) {
  const d = await sessionDetailWarm(url.searchParams.get('id'));
  if (!d) return json({}, { status: 404 });
  return json(d);
}
