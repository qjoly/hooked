import { json } from '@sveltejs/kit';
import { searchIndex } from '$lib/server/core.js';

export function GET({ url }) {
  const q = url.searchParams.get('q') || '';
  const project = url.searchParams.get('project') || null;
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const results = searchIndex.search(q, { project, limit });
  return json({ q, results });
}
