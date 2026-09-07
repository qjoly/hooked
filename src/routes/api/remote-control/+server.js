import { json } from '@sveltejs/kit';
import { readSettings, remoteControlStatus } from '$lib/server/core.js';
import { toPromise } from '$lib/server/respond.js';

// Per-project status of the remote-control daemons (settings.remoteControlProjects → is the daemon
// session up?). Read-only; the project list itself is edited via /api/settings. Polled by the
// Settings → Remote control card.
export async function GET() {
  const { info } = await toPromise((cb) => remoteControlStatus(readSettings(), (rows) => cb(null, rows)));
  return json({ projects: info || [] });
}
