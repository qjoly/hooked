/*
 * Characterisation tests for the pi MCP lens (server/piMcp.js): listing from the two mcp.json
 * scopes, and the CRUD (saveMcpPi / removeMcpPi / getMcpPi) that manages them from the dashboard.
 * PI_CODING_AGENT_DIR is stubbed to a tmpdir BEFORE importing the module, because the module
 * resolves it once at import time.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-pi-agent-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-pi-proj-'));
// HOME est déplacé aussi : piMcp.js lit l'ancien ~/.pi/config.toml via os.homedir().
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-pi-home-'));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = fakeHome;

const { listMcpPi, getMcpPi, saveMcpPi, removeMcpPi, migrateLegacyToml } = await import('../server/piMcp.js');

const userFile = path.join(agentDir, 'mcp.json');
const projectFile = path.join(project, '.pi', 'mcp.json');
const legacyToml = path.join(fakeHome, '.pi', 'config.toml');

beforeAll(() => {
  fs.rmSync(userFile, { force: true });
  fs.rmSync(projectFile, { force: true });
  fs.rmSync(legacyToml, { force: true });
});

describe('listMcpPi', () => {
  it('merges user + project scopes, project wins on a name clash', async () => {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(userFile, JSON.stringify({
      mcpServers: {
        shared: { command: 'user-cmd' },
        onlyUser: { url: 'https://u.example.com', type: 'http' },
      },
    }));
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, JSON.stringify({
      mcpServers: { shared: { command: 'proj-cmd' } },
    }));
    const { servers } = await listMcpPi(project, { check: false });
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
    expect(byName.shared.scope).toBe('project');
    expect(byName.shared.command).toBe('proj-cmd');
    expect(byName.onlyUser.scope).toBe('user');
    expect(byName.onlyUser.transport).toBe('http');
    fs.rmSync(userFile, { force: true });
    fs.rmSync(projectFile, { force: true });
  });

  it('lists enabled:false servers as disabled instead of hiding them', async () => {
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, JSON.stringify({
      mcpServers: { off: { command: 'x', enabled: false } },
    }));
    const { servers } = await listMcpPi(project, { check: false });
    expect(servers[0].state).toBe('disabled');
    expect(servers[0].enabled).toBe(false);
    fs.rmSync(projectFile, { force: true });
  });
});

describe('saveMcpPi / getMcpPi / removeMcpPi', () => {
  it('creates the project mcp.json, saves a stdio server, reads it back', () => {
    const r = saveMcpPi({ cwd: project, scope: 'project', name: 'hooked', config: { command: 'node', args: ['mcp/server.cjs'] } });
    expect(r.ok).toBe(true);
    const g = getMcpPi(project, 'hooked');
    expect(g.ok).toBe(true);
    expect(g.scope).toBe('project');
    expect(g.command).toBe('node');
    expect(g.args).toEqual(['mcp/server.cjs']);
  });

  it('keeps unrelated keys of the file and writes the user file with mode 0600', () => {
    fs.writeFileSync(userFile, JSON.stringify({ mcpServers: {}, other: { keep: 1 } }));
    const r = saveMcpPi({ cwd: project, scope: 'user', name: 'remote', config: { url: 'https://m.example.com', headers: { Authorization: 'Bearer x' } } });
    expect(r.ok).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    expect(onDisk.other).toEqual({ keep: 1 });
    expect(onDisk.mcpServers.remote.headers.Authorization).toBe('Bearer x');
    expect(fs.statSync(userFile).mode & 0o777).toBe(0o600);
  });

  it('drops unknown config fields and refuses an invalid name or an empty config', () => {
    const r = saveMcpPi({ cwd: project, scope: 'project', name: 'x', config: { command: 'c', evil: 'drop-me' } });
    expect(r.server).not.toHaveProperty('evil');
    expect(() => saveMcpPi({ cwd: project, scope: 'project', name: 'bad name!', config: { command: 'c' } })).toThrow('invalid server name');
    expect(() => saveMcpPi({ cwd: project, scope: 'project', name: 'x', config: {} })).toThrow('url');
  });

  it('toggles enabled via save and removes via removeMcpPi', async () => {
    saveMcpPi({ cwd: project, scope: 'project', name: 'hooked', config: { command: 'node', enabled: false } });
    let { servers } = await listMcpPi(project, { check: false });
    expect(servers.find((s) => s.name === 'hooked').state).toBe('disabled');
    saveMcpPi({ cwd: project, scope: 'project', name: 'hooked', config: { command: 'node' } });
    ({ servers } = await listMcpPi(project, { check: false }));
    expect(servers.find((s) => s.name === 'hooked').state).toBe('configured');
    const r = removeMcpPi({ cwd: project, scope: 'project', name: 'hooked' });
    expect(r.ok).toBe(true);
    expect(getMcpPi(project, 'hooked').ok).toBe(false);
    expect(removeMcpPi({ cwd: project, scope: 'project', name: 'hooked' }).ok).toBe(false);
  });
});

describe('legacy config.toml (pi < 1.6, ignored by pi 1.6)', () => {
  it('lists [[mcp.servers]] as legacy and migrates them into the user mcp.json (0600, no overwrite)', async () => {
    fs.rmSync(userFile, { force: true });
    fs.rmSync(projectFile, { force: true });
    fs.mkdirSync(path.dirname(legacyToml), { recursive: true });
    fs.writeFileSync(legacyToml, [
      '[mcp]',
      '[[mcp.servers]]',
      'name = "old"',
      'command = "run-me"',
      'args = ["--flag"]',
      'env = { TOKEN = "s3cret" }',
      '',
    ].join('\n'));
    let { servers, diagnostics } = await listMcpPi(project, { check: false });
    expect(servers.map((s) => [s.name, s.state])).toEqual([['old', 'legacy']]);
    expect(diagnostics[0]).toMatch(/old config\.toml/);
    expect(getMcpPi(project, 'old').env).toEqual({ TOKEN: 's3cret' });

    // Un mcp.json existant gagne sur le legacy pour le même nom.
    saveMcpPi({ cwd: project, scope: 'user', name: 'old', config: { command: 'new-cmd' } });
    const mig = migrateLegacyToml({ cwd: project });
    expect(mig.migrated).toEqual([]); // déjà présent dans mcp.json → pas écrasé
    expect(getMcpPi(project, 'old').command).toBe('new-cmd');

    // Sans mcp.json : la migration écrit le user file en 0600.
    fs.rmSync(userFile, { force: true });
    const mig2 = migrateLegacyToml({ cwd: project });
    expect(mig2.migrated).toEqual(['old']);
    const onDisk = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    expect(onDisk.mcpServers.old).toEqual({ command: 'run-me', args: ['--flag'], env: { TOKEN: 's3cret' } });
    expect(fs.statSync(userFile).mode & 0o777).toBe(0o600);
    ({ servers } = await listMcpPi(project, { check: false }));
    expect(servers.find((s) => s.name === 'old').state).toBe('configured');
    fs.rmSync(legacyToml, { force: true });
    fs.rmSync(userFile, { force: true });
  });
});
