import { json } from '@sveltejs/kit';
import { readQueryResult } from '../../../../server/queryResult.js';

export function GET({ url }) {
  const q = url.searchParams;
  const r = readQueryResult(q.get('session') || '', q.get('agent') || '', q.get('id') || '');
  return r ? json(r) : json({ error: 'Query not found' }, { status: 404 });
}
