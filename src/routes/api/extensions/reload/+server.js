import { json } from '@sveltejs/kit';
import { reloadExtension, listExtensions } from '#lib/server/core.js';
import { fail, readJson } from '#lib/server/respond.js';

// { id }: picks up what is on disk for that extension now (installed, updated or removed).
// The launcher calls it after placing a folder.
export async function POST({ request }) {
  const body = await readJson(request);
  try {
    const result = await reloadExtension(body?.id);
    return json({ ...listExtensions(), result });
  } catch (e) {
    return fail(400, e.message || String(e));
  }
}
