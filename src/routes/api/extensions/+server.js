import { json } from '@sveltejs/kit';
import { listExtensions, writeSettings, readSettings, applyExtensionSettings } from '#lib/server/core.js';
import { fail, readJson } from '#lib/server/respond.js';

// The extensions as the dashboard, the desktop app and the launcher list them (docs/extensions.md).
export function GET() {
  return json(listExtensions());
}

// { id, enabled }: switches one extension, with no restart.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body.id !== 'string' || typeof body.enabled !== 'boolean') return fail(400, 'expected { id, enabled }');
  const settings = writeSettings({ extensions: { ...readSettings().extensions, [body.id]: body.enabled } });
  applyExtensionSettings(settings);
  return json(listExtensions(settings));
}
