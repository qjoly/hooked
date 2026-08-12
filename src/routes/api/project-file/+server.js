import { json } from '@sveltejs/kit';
import { readProjectFile, writeProjectFile } from '$lib/server/core.js';

// GET  ?id=<session>&path=<abs|rel>  → { ok, content, mtimeMs, rel, binary? , tooLarge? , error? }
export function GET({ url }) {
  const r = readProjectFile(url.searchParams.get('id'), url.searchParams.get('path'));
  return json(r, { status: r.ok ? 200 : 400 });
}

// POST { id, path, content }  → { ok, mtimeMs } | { ok:false, error }  (auto-save de l'éditeur)
export async function POST({ request }) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'invalid json' }, { status: 400 }); }
  const r = writeProjectFile(body.id, body.path, body.content);
  return json(r, { status: r.ok ? 200 : 400 });
}
