import { json } from '@sveltejs/kit';
import { sessionDetail } from '$lib/server/core.js';

export function GET({ url }) {
  const d = sessionDetail(url.searchParams.get('id'));
  if (!d) return json({}, { status: 404 });
  return json(d);
}
