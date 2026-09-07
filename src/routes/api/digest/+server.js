import { json } from '@sveltejs/kit';
import { listDigests, readDigest, startGeneration, isValidDate, yesterdayLocal } from '$lib/server/core.js';
import { fail, readJson } from '$lib/server/respond.js';

// Daily digests. GET without `date` → history index + latest date. GET with `date` → that digest
// (or { status: 'absent' } if never generated). POST { date?, force? } → kick off (async)
// generation; the client polls GET until status is `done`/`partial`/`error`.
export function GET({ url }) {
  const date = url.searchParams.get('date');
  if (date) {
    if (!isValidDate(date)) return fail(400, 'invalid date');
    return json(readDigest(date) || { date, status: 'absent' });
  }
  const digests = listDigests();
  return json({ digests, latest: digests[0]?.date || null, yesterday: yesterdayLocal() });
}

export async function POST({ request }) {
  const body = await readJson(request);
  const date = (body && typeof body.date === 'string' && body.date) || yesterdayLocal();
  if (!isValidDate(date)) return fail(400, 'invalid date');
  try {
    const digest = startGeneration(date, { force: !!(body && body.force) });
    return json({ ok: true, digest });
  } catch (e) {
    return fail(500, e.message || String(e));
  }
}
