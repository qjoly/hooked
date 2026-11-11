import { json } from '@sveltejs/kit';
import { listBases } from '$lib/server/core.js';
import { fail } from '$lib/server/respond.js';

export async function GET({ url }) {
  const cwd = url.searchParams.get('cwd');
  if (!cwd || !cwd.startsWith('/')) return fail(400, 'absolute cwd required');
  const res = await listBases(cwd);
  if (!res.root) return fail(400, res.error);
  return json(res);
}
