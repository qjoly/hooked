/*
 * /api/incidents (src/routes/api/incidents/+server.js re-exports this). Read only:
 *   GET                    what the connection can do and for whom ({ available, reason?, writable, me, scopes })
 *   GET ?scope=<key>&after → one page of a list ({ incidents, total, cursor })
 *   GET ?id=<id>           one incident in detail
 * The writes (merge, pin, roles) stay in the desktop app for now.
 */
import { json } from '@sveltejs/kit';
import { gated } from '#lib/server/modules.js';
import { incidentStatus, listIncidents, showIncident } from './server/incidents.js';

export const GET = gated('incidents', async ({ url }) => {
  const q = url.searchParams;
  try {
    if (q.get('id')) return json({ incident: await showIncident(q.get('id')) });
    if (q.get('scope')) {
      await incidentStatus(); // who "Mine" is about
      return json(await listIncidents({ scope: q.get('scope'), after: q.get('after') }));
    }
    return json(await incidentStatus({ refresh: q.has('refresh') }));
  } catch (e) {
    return json({ error: e.message || String(e) }, { status: 502 });
  }
});
