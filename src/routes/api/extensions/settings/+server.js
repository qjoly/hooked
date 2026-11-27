import { json } from '@sveltejs/kit';
import { getExtensionSettings, saveExtensionSettings } from '#lib/server/core.js';
import { fail, readJson } from '#lib/server/respond.js';

// The declarative settings of one extension: GET ?id= → { schema, values }.
export function GET({ url }) {
  const s = getExtensionSettings(url.searchParams.get('id'));
  return s ? json(s) : fail(404, 'unknown extension');
}

// { id, values } → { ok, values } or 400 { errors } (one message per key).
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body.id !== 'string') return fail(400, 'expected { id, values }');
  const r = saveExtensionSettings(body.id, body.values);
  if (r.errors) return json({ ok: false, error: 'invalid settings', errors: r.errors }, { status: 400 });
  return json({ ok: true, values: r.values });
}
