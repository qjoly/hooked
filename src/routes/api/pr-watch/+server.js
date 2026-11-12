import { json } from '@sveltejs/kit';
import { sessionIdForLaunchKey, watchPullRequest, unwatchPullRequest, listPrWatches } from '$lib/server/core.js';

// Called by the hooked MCP server's watch_pull_request / unwatch_pull_request tools.
export async function POST({ request }) {
  const { op, id: rawId, launchKey, url } = await request.json();
  const id = rawId || sessionIdForLaunchKey(launchKey);
  if (!id) return json({ error: 'only a session driven by hooked can watch a pull request' }, { status: 400 });
  try {
    if (op === 'watch') return json({ ok: true, ...(await watchPullRequest(id, url)) });
    if (op === 'unwatch') return json({ ok: true, removed: unwatchPullRequest(id, url) });
    if (op === 'list') return json({ ok: true, urls: listPrWatches(id) });
    return json({ error: 'op must be watch, unwatch or list' }, { status: 400 });
  } catch (e) {
    return json({ error: e.message || String(e) }, { status: 400 });
  }
}
