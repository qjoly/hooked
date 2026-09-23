import { json } from '@sveltejs/kit';
import { readSessionMeta, setSessionMeta, writeSessionMeta, joinGroup, leaveGroup, setGroupMother, renameGroup } from '$lib/server/core.js';
import { fail, readJson } from '$lib/server/respond.js';

// Per-session Deck metadata persisted server-side (session-meta.json): archived flag +
// snooze deadline. GET returns { meta: { [id]: { archived?, snoozeUntil? } } }.
// POST accepts either { id, archived?, snoozeUntil? } (merge-patch one session) or
// { replace: map } (replace the whole map — one-shot migration of historical
// localStorage state, same scheme as /api/tags).
// Session groups go through { op, id, … }: 'join' (+ target), 'leave', 'mother', 'rename' (+ name).
export function GET() {
  return json({ meta: readSessionMeta() });
}

export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return fail(400, 'invalid request');
  try {
    let meta;
    if (body.op === 'join') meta = joinGroup(body.id, body.target);
    else if (body.op === 'leave') meta = leaveGroup(body.id);
    else if (body.op === 'mother') meta = setGroupMother(body.id);
    else if (body.op === 'rename') meta = renameGroup(body.id, body.name);
    else if (body.op) return fail(400, 'unknown op');
    else if (body.replace && typeof body.replace === 'object') meta = writeSessionMeta(body.replace);
    else if (typeof body.id === 'string') meta = setSessionMeta(body.id, body);
    else return fail(400, 'invalid request');
    return json({ ok: true, meta });
  } catch (e) {
    return fail(500, e.message || String(e));
  }
}
