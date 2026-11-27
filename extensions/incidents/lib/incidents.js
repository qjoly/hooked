/*
 * Pure model of the incident.io extension, shared by the server and the page (and mirrored by the
 * desktop app's desktop/src/incidents.rs): the list scopes, the list arguments, and the prompt a
 * session starts from.
 */
export const PAGE_SIZE = 50;

export const SCOPES = [
  { key: 'open', label: 'Open', categories: ['triage', 'active', 'paused'], mine: false },
  { key: 'mine', label: 'Mine', categories: ['triage', 'active', 'paused', 'post-incident'], mine: true },
  { key: 'post', label: 'Post-incident', categories: ['post-incident'], mine: false },
  { key: 'closed', label: 'Closed', categories: ['closed'], mine: false },
  { key: 'merged', label: 'Merged', categories: ['merged'], mine: false },
];

// `incident_list` arguments. "Mine" is about one person, so it filters on the caller's roles.
export function listArgs(scope, who = {}, after = null) {
  const a = { page_size: PAGE_SIZE, include: ['summary', 'roles'], status_category: scope.categories };
  if (scope.mine) a.assigned_to = [(who && who.me && who.me.id) || 'me'];
  if (after) a.after = after;
  return a;
}

export const isOpen = (i) => ['triage', 'active', 'paused'].includes(i?.status?.category);
export const leadOf = (i) => (i?.roles || []).find((r) => /lead/i.test(r.role || '')) || null;

// What a session is asked when the user hands it an incident: read only, ask before acting.
export function incidentPrompt(i) {
  return `Look into incident ${i.reference} "${i.name}" (${i.permalink}) with the incident.io tools: read the incident, its alerts and its investigation, then tell me what is going on and what you would check next. Read only: do not change the incident or post anything in its channel without asking me first.`;
}
