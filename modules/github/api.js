/*
 * The GitHub module's API. The routes under src/routes/api re-export these:
 *   /api/github                GET  the page's overview (notifications, issues, PRs)
 *   /api/github/repo           GET  the open PRs of one repo
 *   /api/github/notifications  POST mark notification threads as done
 *   /api/pr-watch              POST watch / unwatch / list (the watch_pull_request tools)
 * The PR / issue / run viewers of the session dock stay in the core (/api/github/detail, diff, run…).
 */
import { json } from '@sveltejs/kit';
import { gated } from '#lib/server/modules.js';
import { ok, fail, readJson } from '#lib/server/respond.js';
import { sessionIdForLaunchKey } from '#server/agent.js';
import { githubOverview, githubRepoPrs, markNotificationsDone } from './server/github.js';
import { watchPullRequest, unwatchPullRequest, listPrWatches } from './server/prWatch.js';

export const overviewGET = gated('github', async ({ url }) => {
  try {
    return json(await githubOverview({ refresh: url.searchParams.has('refresh') }));
  } catch (e) {
    return json({ error: e.message || String(e) }, { status: 502 });
  }
});

export const repoGET = gated('github', async ({ url }) => {
  try {
    return json(await githubRepoPrs(url.searchParams.get('repo'), { refresh: url.searchParams.has('refresh') }));
  } catch (e) {
    return json({ error: e.message || String(e) }, { status: 502 });
  }
});

// Body { ids: [threadId…] } → { ok, done: [threadId…], error }. A GitHub failure on some threads
// is reported in `error`, not thrown, so a throw here can only mean malformed ids.
export const notificationsPOST = gated('github', async ({ request }) => {
  let result;
  try {
    result = await markNotificationsDone((await readJson(request))?.ids);
  } catch (e) {
    return fail(400, e.message);
  }
  const { done, error } = result;
  return done.length || !error ? ok({ done, error }) : fail(502, error);
});

// Called by the module's watch_pull_request / unwatch_pull_request tools.
export const prWatchPOST = gated('github', async ({ request }) => {
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
});
