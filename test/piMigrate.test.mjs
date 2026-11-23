/*
 * `mise run pi-migrate` (scripts/pi-migrate.mjs): the global CLAUDE.md goes into a managed block of
 * pi's AGENTS.md, the Claude skills folder into pi's skills list, and a second run changes nothing.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate, upsertBlock, duplicateHeadings, withSkillsDir, BEGIN, END } from '../scripts/pi-migrate.mjs';

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

  it('adds the skills folder once, whatever the spelling of the existing entry', () => {
    expect(withSkillsDir({ packages: ['x'] }, '/a/skills')).toEqual({ packages: ['x'], skills: ['/a/skills'] });
    expect(withSkillsDir({ skills: ['/a/skills/'] }, '/a/skills')).toBeNull();
    expect(withSkillsDir({ skills: ['+/a/skills'] }, '/a/skills')).toBeNull();
    expect(withSkillsDir({ skills: [path.join(os.homedir(), 'k')] }, '~/k')).toBeNull();
    expect(withSkillsDir({}, path.join(os.homedir(), '.claude', 'skills')).skills).toEqual(['~/.claude/skills']);
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
