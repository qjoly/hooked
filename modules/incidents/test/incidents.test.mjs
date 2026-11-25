/*
 * The incident.io module against a stand-in for `incident mcp` (desktop/scripts/fake-incident, the
 * desktop app's fake server): the MCP client, the lists by scope, the detail, and a missing binary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { SCOPES, listArgs, incidentPrompt, isOpen, leadOf } from '../lib/incidents.js';

const FAKE = path.join(import.meta.dirname, '..', '..', '..', 'desktop', 'scripts', 'fake-incident');
let mod;

beforeAll(async () => {
  process.env.HOOKED_INCIDENT_BIN = FAKE;
  delete globalThis[Symbol.for('hooked.incidents.client')];
  mod = await import('../server/incidents.js');
});
afterAll(() => {
  mod?.closeIncidents();
  delete process.env.HOOKED_INCIDENT_BIN;
});

describe('incident.io model', () => {
  it('builds the list arguments of each scope', () => {
    const mine = SCOPES.find((s) => s.key === 'mine');
    expect(listArgs(SCOPES[0], {}, null)).toEqual({ page_size: 50, include: ['summary', 'roles'], status_category: ['triage', 'active', 'paused'] });
    expect(listArgs(mine, { me: { id: 'U-1' } }, 'C1')).toMatchObject({ assigned_to: ['U-1'], after: 'C1' });
    expect(listArgs(mine, {}, null).assigned_to).toEqual(['me']);
  });

  it('reads an incident: open or not, its lead, the prompt a session starts from', () => {
    const i = { reference: 'INC-1', name: 'Down', permalink: 'https://x/1', status: { category: 'active' }, roles: [{ role: 'Incident Lead', user: 'Ada' }] };
    expect(isOpen(i)).toBe(true);
    expect(isOpen({ status: { category: 'closed' } })).toBe(false);
    expect(leadOf(i).user).toBe('Ada');
    expect(incidentPrompt(i)).toMatch(/^Look into incident INC-1 "Down" \(https:\/\/x\/1\).*Read only/);
  });
});

describe('incident.io through its MCP server', () => {
  it('says what the connection can do and for whom', async () => {
    const st = await mod.incidentStatus();
    expect(st).toMatchObject({ available: true, writable: true, me: { id: 'U-ME', name: 'Ada Lovelace' } });
    expect(st.tools).toContain('incident_list');
    expect(st.scopes.map((s) => s.key)).toEqual(['open', 'mine', 'post', 'closed', 'merged']);
  });

  it('lists the open incidents and the caller\'s own, and shows one in detail', async () => {
    const open = await mod.listIncidents({ scope: 'open' });
    expect(open.incidents.length).toBeGreaterThan(0);
    expect(open.incidents.every((i) => ['triage', 'active', 'paused'].includes(i.status.category))).toBe(true);
    const mine = await mod.listIncidents({ scope: 'mine' });
    expect(mine.incidents.every((i) => i.you?.participant || i.roles?.some((r) => r.user_id === 'U-ME'))).toBe(true);
    const d = await mod.showIncident(open.incidents.find((i) => i.reference === 'INC-409').id);
    expect(d).toMatchObject({ reference: 'INC-409', investigation: { status: 'complete' } });
    expect(d.updates.length).toBeGreaterThan(0);
  });

  it('reports the server\'s own words when a tool refuses', async () => {
    await expect(mod.showIncident('01NOPE')).rejects.toThrow(/incident not found/);
    await expect(mod.listIncidents({ scope: 'bogus' })).rejects.toThrow(/unknown scope/);
  });

  it('is unavailable without the binary', async () => {
    process.env.HOOKED_INCIDENT_BIN = '';
    expect(await mod.incidentStatus({ refresh: true })).toMatchObject({ available: false });
    process.env.HOOKED_INCIDENT_BIN = FAKE;
  });
});
