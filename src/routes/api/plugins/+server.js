import { json } from '@sveltejs/kit';
import { listPlugins, runPluginAction } from '$lib/server/core.js';
import { fail, readJson } from '$lib/server/respond.js';

// Installed plugins + marketplaces of a project. `?available=1` adds the marketplaces' catalog.
// `cwd` matters: project and local scopes are per-directory.
export async function GET({ url }) {
  const available = url.searchParams.get('available') === '1';
  return json(await listPlugins(url.searchParams.get('cwd'), { available }));
}

// { action, cwd, id?, scope?, source? }, actions: install | uninstall | enable | disable | update
// | marketplace-add | marketplace-remove | marketplace-update (see pluginArgs in server/plugins.js).
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || typeof body.action !== 'string') return fail(400, 'action required');
  const { action, cwd, id, scope, source } = body;
  try {
    return json(await runPluginAction(cwd, action, { id, scope, source }));
  } catch (e) {
    return fail(400, e && e.message ? e.message : 'plugin command failed');
  }
}
