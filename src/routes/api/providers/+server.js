import { json } from '@sveltejs/kit';
import { providerList, configuredProviders, listEngines, externalEngineStatus, loadExternalEngines } from '#lib/server/core.js';
import { fail, readJson } from '#lib/server/respond.js';

// Providers (config) and engines (code) known to this hooked, for the settings page and the
// pickers. Cf. server/providers.js and docs/providers.md.
function snapshot() {
  return {
    providers: providerList(),
    enabled: configuredProviders(),
    engines: listEngines().map((e) => ({ id: e.id, label: e.label || e.id, builtin: !!e.builtin, driver: e.id === 'claude' || !!e.driver })),
    external: externalEngineStatus(),
  };
}

export function GET() {
  return json(snapshot());
}

// { action: 'reload' } re-imports the external engine modules (after dropping a new file in the
// providers folder) without restarting hooked.
export async function POST({ request }) {
  const body = await readJson(request);
  if (!body || body.action !== 'reload') return fail(400, 'unknown action');
  await loadExternalEngines(undefined, { force: true });
  return json(snapshot());
}
