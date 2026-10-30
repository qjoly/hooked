import { json } from '@sveltejs/kit';
import { broadcastEvent } from '$lib/server/live.js';
import { sessionIdForLaunchKey } from '$lib/server/core.js';

// Called by the hooked MCP server's show_query tool: the open dashboards pop the chart up.
export async function POST({ request }) {
  const { spec, launchKey } = await request.json();
  if (!spec?.query || !spec?.datasource) return json({ error: 'datasource and query are required' }, { status: 400 });
  broadcastEvent('showQuery', { spec, session: sessionIdForLaunchKey(launchKey) });
  return json({ ok: true });
}
