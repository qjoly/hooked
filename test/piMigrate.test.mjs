/*
 * `mise run pi-migrate` (scripts/pi-migrate.mjs): the global CLAUDE.md goes into a managed block of
 * pi's AGENTS.md, the Claude skills folder into pi's skills list, and a second run changes nothing.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate, upsertBlock, duplicateHeadings, syncSkills, pluginSkillDirs, BEGIN, END } from '../scripts/pi-migrate.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-pi-migrate-'));
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

function setup(name, { claudeMd, agentsMd, settings, skills = ['sre'] } = {}) {
  const claudeDir = path.join(TMP, name, 'claude');
  const agentDir = path.join(TMP, name, 'pi');
  fs.mkdirSync(agentDir, { recursive: true });
  for (const s of skills) {
    fs.mkdirSync(path.join(claudeDir, 'skills', s), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'skills', s, 'SKILL.md'), `---\nname: ${s}\ndescription: x\n---\n`);
  }
  fs.mkdirSync(claudeDir, { recursive: true });
  if (claudeMd != null) fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), claudeMd);
  if (agentsMd != null) fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), agentsMd);
  if (settings != null) fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  return { claudeDir, agentDir };
}
const read = (f) => fs.readFileSync(f, 'utf8');

describe('pi-migrate helpers', () => {
  it('puts the block first, then replaces only the block', () => {
    const once = upsertBlock('# pi only\nkeep me\n', '# Github\nv1\n');
    expect(once).toBe(`${BEGIN}\n# Github\nv1\n${END}\n\n# pi only\nkeep me\n`);
    const twice = upsertBlock(once, '# Github\nv2');
    expect(twice).toBe(`${BEGIN}\n# Github\nv2\n${END}\n\n# pi only\nkeep me\n`);
    expect(upsertBlock('', 'x')).toBe(`${BEGIN}\nx\n${END}\n`);
  });

  it('names the pi-only sections that repeat CLAUDE.md', () => {
    const agents = upsertBlock('# Github\nold copy\n# Simple English\nrules\n', '# Github\nnew\n## Reviews\n');
    expect(duplicateHeadings(agents, '# Github\nnew\n## Reviews\n')).toEqual(['github']);
    // a no-break space in one copy and a plain one in the other still match
    expect(duplicateHeadings('# Code / Commit\n', '## Code /\u00a0Commit\n')).toEqual(['code / commit']);
  });

  it('adds the skills folders once, whatever the spelling, and swaps an older plugin folder', () => {
    expect(syncSkills(['x.md'], ['/a/skills'], []).list).toEqual(['x.md', '/a/skills']);
    expect(syncSkills(['/a/skills/'], ['/a/skills'], []).added).toEqual([]);
    expect(syncSkills(['+/a/skills'], ['/a/skills'], []).added).toEqual([]);
    expect(syncSkills([path.join(os.homedir(), 'k')], ['~/k'], []).added).toEqual([]);
    expect(syncSkills([], [path.join(os.homedir(), '.claude', 'skills')], []).list).toEqual(['~/.claude/skills']);
    // a plugin update: v1 was added by an earlier run, v2 is wanted now; the user's own entry stays
    const r = syncSkills(['/mine', '/p/v1/skills'], ['/c/skills', '/p/v2/skills'], ['/p/v1/skills']);
    expect(r).toEqual({ list: ['/mine', '/c/skills', '/p/v2/skills'], added: ['/c/skills', '/p/v2/skills'], removed: ['/p/v1/skills'] });
  });
});

describe('pi-migrate', () => {
  it('migrates, keeps the pi-only content, backs the files up once, and is idempotent', () => {
    const { claudeDir, agentDir } = setup('full', {
      claudeMd: '# Github\nIntent only.\n',
      agentsMd: '# Commit attribution\nNo trailers.\n',
      settings: { packages: ['git:github.com/x/y'], defaultProvider: 'mistral' },
    });
    const r = migrate({ claudeDir, agentDir });
    expect(r.instructions.status).toBe('added');
    expect(r.skills).toMatchObject({ status: 'added', entries: 1 });
    const agents = read(path.join(agentDir, 'AGENTS.md'));
    expect(agents.startsWith(`${BEGIN}\n# Github\nIntent only.\n${END}`)).toBe(true);
    expect(agents).toContain('# Commit attribution\nNo trailers.');
    const settings = JSON.parse(read(path.join(agentDir, 'settings.json')));
    expect(settings).toEqual({ packages: ['git:github.com/x/y'], defaultProvider: 'mistral', skills: [path.join(claudeDir, 'skills')] });
    expect(read(path.join(agentDir, 'AGENTS.md.pre-pi-migrate.bak'))).toBe('# Commit attribution\nNo trailers.\n');
    expect(fs.existsSync(path.join(agentDir, 'settings.json.pre-pi-migrate.bak'))).toBe(true);

    const again = migrate({ claudeDir, agentDir });
    expect(again.instructions.status).toBe('unchanged');
    expect(again.skills.status).toBe('present');

    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# Github\nIntent only, short.\n');
    expect(migrate({ claudeDir, agentDir }).instructions).toMatchObject({ status: 'updated', backup: null });
    expect(read(path.join(agentDir, 'AGENTS.md'))).toContain('Intent only, short.');
    expect(read(path.join(agentDir, 'AGENTS.md.pre-pi-migrate.bak'))).toBe('# Commit attribution\nNo trailers.\n');
  });

  it('writes nothing on a dry run, and skips what is missing', () => {
    const { claudeDir, agentDir } = setup('dry', { claudeMd: '# A\n', skills: [] });
    fs.rmSync(path.join(claudeDir, 'skills'), { recursive: true, force: true });
    const r = migrate({ claudeDir, agentDir, dryRun: true });
    expect(r.instructions.status).toBe('added');
    expect(r.skills.status).toBe('no-source');
    expect(fs.existsSync(path.join(agentDir, 'AGENTS.md'))).toBe(false);
    const none = setup('none', {});
    expect(migrate(none).instructions.status).toBe('no-source');
  });

  it('refuses to rewrite a settings file it cannot parse', () => {
    const { claudeDir, agentDir } = setup('bad', { claudeMd: '# A\n' });
    fs.writeFileSync(path.join(agentDir, 'settings.json'), '{ nope');
    expect(() => migrate({ claudeDir, agentDir })).toThrow(/not valid JSON/);
    expect(read(path.join(agentDir, 'settings.json'))).toBe('{ nope');
  });
});

describe('pi-migrate: MCP servers', () => {
  const incident = { command: '/x/incident', args: ['mcp'] };
  const gateway = { type: 'http', url: 'https://gw.example/mcp' };

  it('copies Claude\'s servers, keeps pi\'s, skips hooked and SSE, and flags OAuth sign-ins', async () => {
    const { mergeMcp } = await import('../scripts/pi-migrate.mjs');
    const r = mergeMcp(
      { incident_io: incident, 'mcp-gateway': gateway, hooked: { command: 'node' }, old: { type: 'sse', url: 'https://x/sse' }, homeassistant: { command: 'other' } },
      { homeassistant: { command: 'ha' } },
      {},
    );
    expect(r.servers).toEqual({ homeassistant: { command: 'ha' }, incident_io: incident, 'mcp-gateway': gateway });
    expect(r.recorded).toEqual({ incident_io: incident, 'mcp-gateway': gateway });
    const by = Object.fromEntries(r.changes.map((c) => [c.name, c]));
    expect(by.incident_io).toMatchObject({ action: 'added', login: false });
    expect(by['mcp-gateway']).toMatchObject({ action: 'added', login: true });
    expect(by.hooked.action).toBe('skipped');
    expect(by.old.action).toBe('skipped');
    expect(by.homeassistant).toMatchObject({ action: 'kept', why: 'pi already has a server of that name' });
  });

  it('follows Claude\'s changes on its own copies only', async () => {
    const { mergeMcp } = await import('../scripts/pi-migrate.mjs');
    const recorded = { incident_io: incident, 'mcp-gateway': gateway, gone: { command: 'g' } };
    const pi = { incident_io: incident, 'mcp-gateway': { ...gateway, exposure: 'direct' }, gone: { command: 'g' } };
    const r = mergeMcp({ incident_io: { ...incident, args: ['mcp', '--v2'] }, 'mcp-gateway': gateway }, pi, recorded);
    expect(r.servers.incident_io.args).toEqual(['mcp', '--v2']); // updated: untouched in pi
    expect(r.servers['mcp-gateway'].exposure).toBe('direct'); // kept: edited in pi
    expect('gone' in r.servers).toBe(false); // removed: Claude dropped it
    expect(r.changes.map((c) => `${c.name}:${c.action}`)).toEqual(['incident_io:updated', 'mcp-gateway:kept', 'gone:removed']);
  });

  it('writes mcp.json (mode 0600) and its record, then changes nothing on a second run', () => {
    const { claudeDir, agentDir } = setup('mcp', { claudeMd: '# A\n' });
    const claudeJson = path.join(TMP, 'mcp', '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ numStartups: 3, mcpServers: { incident_io: incident } }));
    fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { hooked: { command: 'node' } } }));
    const r = migrate({ claudeDir, agentDir, claudeJson });
    expect(r.mcp.status).toBe('changed');
    const file = path.join(agentDir, 'mcp.json');
    expect(JSON.parse(read(file)).mcpServers).toEqual({ hooked: { command: 'node' }, incident_io: incident });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(read(path.join(agentDir, 'pi-migrate.json'))).mcpServers).toEqual({ incident_io: incident });
    expect(migrate({ claudeDir, agentDir, claudeJson }).mcp.status).toBe('unchanged');
  });
});

describe('pi-migrate: plugin skills', () => {
  function plugins(name, version, { enabled = true, synced = false } = {}) {
    const { claudeDir, agentDir } = setup(name, { claudeMd: '# A\n' });
    const install = (v) => {
      const dir = path.join(claudeDir, 'plugins', 'cache', 'dir', 'tool', v);
      fs.mkdirSync(path.join(dir, 'skills', 'incidents'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'skills', 'incidents', 'SKILL.md'), '---\nname: incidents\ndescription: x\n---\n');
      fs.writeFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
        'tool@dir': [{ scope: 'user', installPath: dir, version: v }],
        'other@dir': [{ scope: 'project', projectPath: '/x', installPath: path.join(claudeDir, 'nowhere') }],
      } }));
      return dir;
    };
    const first = install(version);
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'tool@dir': enabled } }));
    if (synced) fs.mkdirSync(path.join(claudeDir, 'plugins', 'synced', 'bucket', 'design', 'skills'), { recursive: true });
    return { claudeDir, agentDir, first, install };
  }

  it('lists the skills of enabled plugins, and leaves out disabled and synced ones', () => {
    const on = plugins('plug-on', 'v1', { synced: true });
    const found = pluginSkillDirs(on.claudeDir);
    expect(found.dirs).toEqual([{ name: 'tool@dir', dir: path.join(on.first, 'skills') }]);
    expect(found.skipped.map((s) => s.name)).toEqual(['design']);
    // synced plugins join on request
    const all = pluginSkillDirs(on.claudeDir, { withSynced: true });
    expect(all.dirs.map((d) => d.name)).toEqual(['tool@dir', 'design']);
    expect(all.skipped).toEqual([]);
    const off = plugins('plug-off', 'v1', { enabled: false });
    expect(pluginSkillDirs(off.claudeDir)).toEqual({ dirs: [], skipped: [{ name: 'tool@dir', why: 'not enabled' }] });
  });

  it('adds them to pi, follows a plugin update, and keeps the MCP record beside them', () => {
    const { claudeDir, agentDir, first, install } = plugins('plug-run', 'v1');
    const claudeJson = path.join(TMP, 'plug-run', '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { slack: { command: 'slack-mcp' } } }));
    const r = migrate({ claudeDir, agentDir, claudeJson });
    expect(r.skills.plugins).toEqual([{ name: 'tool@dir', dir: path.join(first, 'skills'), action: 'added' }]);
    const settingsFile = path.join(agentDir, 'settings.json');
    expect(JSON.parse(read(settingsFile)).skills).toEqual([path.join(claudeDir, 'skills'), path.join(first, 'skills')]);

    const second = install('v2');
    const r2 = migrate({ claudeDir, agentDir, claudeJson });
    expect(r2.skills.removed).toEqual([path.join(first, 'skills')]);
    expect(JSON.parse(read(settingsFile)).skills).toEqual([path.join(claudeDir, 'skills'), path.join(second, 'skills')]);
    const state = JSON.parse(read(path.join(agentDir, 'pi-migrate.json')));
    expect(state).toEqual({ pluginSkills: [path.join(second, 'skills')], mcpServers: { slack: { command: 'slack-mcp' } } });
    expect(migrate({ claudeDir, agentDir, claudeJson }).skills.removed).toEqual([]);
  });
});

describe('pi-migrate: claude.ai connectors', () => {
  it('reads the connectors of `claude mcp list`', async () => {
    const { parseConnectors } = await import('../scripts/pi-migrate.mjs');
    const out = [
      'Checking MCP server health…',
      '',
      'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - \u001b[32m✔ Connected\u001b[39m',
      'claude.ai Notion: https://mcp.notion.com/mcp - ! Needs authentication',
      'incident_io: /x/incident mcp - ✔ Connected',
    ].join('\n');
    expect(parseConnectors(out)).toEqual([
      { name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1', connected: true },
      { name: 'Notion', url: 'https://mcp.notion.com/mcp', connected: false },
    ]);
  });

  it('tells open, OAuth-capable and closed servers apart by their OAuth metadata', async () => {
    const { probeConnector } = await import('../scripts/pi-migrate.mjs');
    const http = await import('node:http');
    let base;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const json = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
        const mode = req.url.split('/').pop();
        if (req.url.startsWith('/.well-known/oauth-protected-resource/')) {
          const m = req.url.split('/').pop();
          if (m === 'open') return json(404, {});
          return json(200, { resource: `${base}/${m}`, authorization_servers: [`${base}/as-${m}`] });
        }
        if (req.url === '/.well-known/oauth-protected-resource') return json(404, {});
        if (req.url.startsWith('/as-')) {
          const m = req.url.split('/')[1].slice(3);
          return json(200, m === 'dcr' ? { issuer: base, registration_endpoint: `${base}/register` } : { issuer: base });
        }
        const rpc = body ? JSON.parse(body) : {};
        if (mode === 'dcr' && rpc.method === 'initialize') { res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/x/dcr"` }); return res.end(); }
        if (rpc.method === 'initialize') return json(200, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {} } });
        if (rpc.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'a' }, { name: 'b' }] } });
        return json(202, {});
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    try {
      expect(await probeConnector(`${base}/x/open`)).toEqual({ access: 'open', tools: 2 });
      expect(await probeConnector(`${base}/x/dcr`)).toEqual({ access: 'oauth' });
      // lists its tools to anyone, but publishes OAuth metadata with a closed authorization server
      expect(await probeConnector(`${base}/x/closed`)).toMatchObject({ access: 'closed', why: expect.stringMatching(/pre-registered/) });
      expect(await probeConnector('http://127.0.0.1:1/nothing')).toMatchObject({ access: 'closed', why: expect.stringMatching(/unreachable/) });
    } finally { server.close(); }
  });

  it('keeps the usable connectors, names them, and carries them over when they are not listed', async () => {
    const { claudeConnectors } = await import('../scripts/pi-migrate.mjs');
    const out = [
      'claude.ai Design Docs: https://docs.example/mcp/k - ✔ Connected',
      'claude.ai Linear: https://linear.example/mcp - ✔ Connected',
      'claude.ai Gmail: https://gmail.example/mcp - ✔ Connected',
      'claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected',
      'claude.ai Notion: https://notion.example/mcp - ! Needs authentication',
      'claude.ai Slack: https://slack.example/mcp - ✔ Connected',
    ].join('\n');
    const access = { 'https://docs.example/mcp/k': { access: 'open' }, 'https://linear.example/mcp': { access: 'oauth' }, 'https://gmail.example/mcp': { access: 'closed', why: 'pre-registered only' }, 'https://slack.example/mcp': { access: 'oauth' } };
    const conn = await claudeConnectors({ list: async () => out, probe: async (u) => access[u], taken: new Set(['slack']) });
    expect(conn.servers).toEqual({ 'design-docs': { url: 'https://docs.example/mcp/k' }, linear: { url: 'https://linear.example/mcp' }, 'claudeai-slack': { url: 'https://slack.example/mcp' } });
    expect(conn.report.filter((r) => r.action === 'skipped').map((r) => r.name)).toEqual(['Gmail', 'Claude Docs', 'Notion']);

    const { claudeDir, agentDir } = setup('conn', { claudeMd: '# A\n' });
    const claudeJson = path.join(TMP, 'conn', '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { slack: { command: 'slack-mcp' } } }));
    const r = migrate({ claudeDir, agentDir, claudeJson, connectors: conn });
    const by = Object.fromEntries(r.mcp.changes.map((c) => [c.name, c]));
    expect(by['design-docs']).toMatchObject({ action: 'added', login: false }); // open: no sign-in
    expect(by.linear).toMatchObject({ action: 'added', login: true });
    // a run where the connectors could not be listed keeps them
    const later = migrate({ claudeDir, agentDir, claudeJson, connectors: { servers: {}, report: [], listed: false } });
    expect(later.mcp.status).toBe('unchanged');
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp.json'), 'utf8')).mcpServers).sort()).toEqual(['claudeai-slack', 'design-docs', 'linear', 'slack']);
    // a listing where Linear is gone removes its copy
    const gone = migrate({ claudeDir, agentDir, claudeJson, connectors: { ...conn, servers: { 'design-docs': conn.servers['design-docs'] } } });
    expect(gone.mcp.changes.find((c) => c.name === 'linear')).toMatchObject({ action: 'removed' });
  });
});

describe('pi-migrate: OAuth clients and unconnected connectors', () => {
  it('reads a Google client from the environment only', async () => {
    const { oauthClientsFromEnv } = await import('../scripts/pi-migrate.mjs');
    expect(oauthClientsFromEnv({})).toEqual({});
    expect(oauthClientsFromEnv({ PI_MIGRATE_GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', PI_MIGRATE_GOOGLE_CLIENT_SECRET: 's' }))
      .toEqual({ 'accounts.google.com': { clientId: 'id.apps.googleusercontent.com', clientSecret: 's' } });
  });

  it('copies Google connectors with the user\'s client, and unconnected ones on request', async () => {
    const { claudeConnectors } = await import('../scripts/pi-migrate.mjs');
    const out = [
      'claude.ai Gmail: https://gmail.example/mcp - ✔ Connected',
      'claude.ai Notion: https://notion.example/mcp - ! Needs authentication',
      'claude.ai Box: https://box.example/mcp - ! Needs authentication',
    ].join('\n');
    const probe = async (u) => ({
      'https://gmail.example/mcp': { access: 'closed', authHost: 'accounts.google.com', why: 'pre-registered only' },
      'https://notion.example/mcp': { access: 'oauth' },
      'https://box.example/mcp': { access: 'closed', authHost: 'account.box.com', why: 'pre-registered only' },
    }[u]);
    const list = async () => out;

    const plain = await claudeConnectors({ list, probe });
    expect(plain.servers).toEqual({});
    expect(plain.report.find((r) => r.name === 'Gmail').why).toMatch(/PI_MIGRATE_GOOGLE_CLIENT_ID/);
    expect(plain.report.find((r) => r.name === 'Notion').why).toMatch(/--with-unconnected/);

    const full = await claudeConnectors({ list, probe, withUnconnected: true, clients: { 'accounts.google.com': { clientId: 'cid', clientSecret: 'cs' } } });
    expect(full.servers).toEqual({
      gmail: { url: 'https://gmail.example/mcp', oauth: { clientId: 'cid', clientSecret: 'cs' } },
      notion: { url: 'https://notion.example/mcp' },
    });
    expect(full.report.find((r) => r.name === 'Box')).toMatchObject({ action: 'skipped', why: 'pre-registered only' });
  });
});
