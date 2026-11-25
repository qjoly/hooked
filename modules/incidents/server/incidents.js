/*
 * The incident.io module's reads: what the connection can do and for whom, the incident lists by
 * scope, and one incident in detail. Everything goes through the incident.io desktop binary's MCP
 * server (./client.js), one process shared by the whole of hooked and pinned on globalThis.
 */
import { IncidentClient, findIncidentBin } from './client.js';
import { SCOPES, PAGE_SIZE, listArgs } from '../lib/incidents.js';

const SLOT = Symbol.for('hooked.incidents.client');
const HELLO_TTL_MS = 5 * 60_000;

function client() {
  const bin = findIncidentBin();
  const cur = globalThis[SLOT];
  if (cur && cur.bin === bin) return cur.client;
  cur?.client?.close();
  if (!bin) { globalThis[SLOT] = { bin: null, client: null }; return null; }
  globalThis[SLOT] = { bin, client: new IncidentClient(bin), hello: null };
  return globalThis[SLOT].client;
}

// The module was switched off: no process left behind.
export function closeIncidents() {
  globalThis[SLOT]?.client?.close();
  globalThis[SLOT] = null;
}

// The first exchange: is there a binary, which tools it serves, whether writes are allowed, who
// the caller is. Cached a few minutes; a failure is not cached.
export async function incidentStatus({ refresh = false } = {}) {
  const c = client();
  if (!c) return { available: false, reason: 'The incident.io desktop app is not installed on this machine.' };
  const slot = globalThis[SLOT];
  if (!refresh && slot.hello && Date.now() - slot.hello.at < HELLO_TTL_MS) return slot.hello.value;
  try {
    const tools = await c.tools();
    if (!tools.includes('incident_list')) throw new Error('the incident.io server lists no incident tools');
    let me = null;
    let writable = true;
    if (tools.includes('identity_show')) {
      const id = await c.tool('identity_show', {});
      me = id?.user ? { id: id.user.id, name: id.user.name } : null;
      // Only an explicit read-only level hides the writes.
      writable = !(typeof id?.access_level === 'string' && !id.access_level.includes('write'));
    }
    const value = { available: true, tools, writable, me, organisation: null, scopes: SCOPES.map(({ key, label }) => ({ key, label })) };
    slot.hello = { at: Date.now(), value };
    return value;
  } catch (e) {
    return { available: false, reason: e.message || String(e) };
  }
}

export async function listIncidents({ scope = 'open', after = null } = {}) {
  const c = client();
  if (!c) throw new Error('The incident.io desktop app is not installed on this machine.');
  const s = SCOPES.find((x) => x.key === scope);
  if (!s) throw new Error('unknown scope: ' + scope);
  const me = globalThis[SLOT]?.hello?.value?.me || null;
  const v = await c.tool('incident_list', listArgs(s, { me }, after));
  const p = v?.pagination || {};
  return {
    incidents: Array.isArray(v?.incidents) ? v.incidents : [],
    total: typeof p.total_count === 'number' ? p.total_count : null,
    cursor: p.has_more && p.next_cursor ? p.next_cursor : null,
    pageSize: PAGE_SIZE,
  };
}

export async function showIncident(id) {
  const c = client();
  if (!c) throw new Error('The incident.io desktop app is not installed on this machine.');
  if (typeof id !== 'string' || !id || id.length > 64) throw new Error('invalid incident id');
  return c.tool('incident_show', { id, include: ['investigation'] });
}
