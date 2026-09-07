import { json } from '@sveltejs/kit';
import { readSessionMeta, setSessionMeta, writeSessionMeta } from '$lib/server/core.js';
import { fail, readJson } from '$lib/server/respond.js';

// Per-session Deck metadata persisted server-side (session-meta.json): archived flag +
// snooze deadline. GET returns { meta: { [id]: { archived?, snoozeUntil? } } }.
// POST accepts either { id, archived?, snoozeUntil? } (merge-patch one session) or
// { replace: map } (replace the whole map — one-shot migration of historical
// localStorage state, same scheme as /api/tags).
export function GET() {
  return json({ meta: readSessionMeta() });
}

export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return fail(400, 'invalid request');
  try {
    let meta;
    if (body.replace && typeof body.replace === 'object') meta = writeSessionMeta(body.replace);
    else if (typeof body.id === 'string') meta = setSessionMeta(body.id, body);
    else return fail(400, 'invalid request');
    return json({ ok: true, meta });
  } catch (e) {
    return fail(500, e.message || String(e));
  }
}
