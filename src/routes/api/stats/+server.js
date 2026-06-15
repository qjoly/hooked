import { json } from '@sveltejs/kit';
import { buildStats } from '$lib/server/core.js';

export function GET({ url }) {
  const range = url.searchParams.get('range');
  const days = range === 'all' ? 0 : parseInt(range || '7', 10);
  return json(buildStats(days));
}
