// The incident.io module's reads. The server's own words come back on a failure (the binary is
// missing, the connection was lost…), not just the HTTP status.
async function get(url) {
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
  return d;
}

export const getIncidentStatus = (refresh = false) => get('/api/incidents' + (refresh ? '?refresh=1' : ''));
export const getIncidents = (scope, after) => get('/api/incidents?scope=' + encodeURIComponent(scope) + (after ? '&after=' + encodeURIComponent(after) : ''));
export const getIncident = (id) => get('/api/incidents?id=' + encodeURIComponent(id));
