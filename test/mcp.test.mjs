/*
 * Characterisation tests for the `claude mcp` output parsers (server/mcp.js).
 *
 * The CLI has no JSON mode, so its human-readable output IS the contract. The fixtures in
 * test/fixtures/mcp are verbatim captures; when a CLI upgrade changes the format, these tests are
 * what fails, instead of the page silently listing nothing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripCliAnsi, parseServerLine, parseList, parseGet, parseAuthUrl, wantsPaste, readScopes, decorate,
} from '../server/mcp.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp');
const fix = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('stripCliAnsi', () => {
  it('drops CSI colour codes', () => {
    expect(stripCliAnsi(`${ESC}[94mhello${ESC}[39m`)).toBe('hello');
  });

  it('drops OSC-8 hyperlinks without duplicating the URL they carry', () => {
    const u = 'https://example.com/a?b=1';
    expect(stripCliAnsi(`${ESC}]8;;${u}${BEL}${u}${ESC}]8;;${BEL}`)).toBe(u);
  });
});

describe('parseServerLine', () => {
  it('reads an http server with an explicit transport suffix', () => {
    expect(parseServerLine('mcp-gateway: https://gw.example.com/mcp (HTTP) - ✔ Connected')).toEqual({
      name: 'mcp-gateway', target: 'https://gw.example.com/mcp', transport: 'http',
      state: 'connected', status: 'Connected',
    });
  });

  it('infers stdio from a non-URL target, and keeps spaces in the command', () => {
    const r = parseServerLine('incident_io: /home/u/.incidentio/incident mcp - ✔ Connected');
    expect(r).toMatchObject({ name: 'incident_io', target: '/home/u/.incidentio/incident mcp', transport: 'stdio' });
  });

  it('keeps a name containing spaces and dots', () => {
    const r = parseServerLine('claude.ai Figma: https://mcp.figma.com/mcp - ! Needs authentication');
    expect(r).toMatchObject({ name: 'claude.ai Figma', state: 'needs_auth', status: 'Needs authentication' });
  });

  // " - " is legal inside a command, so anchoring on the FIRST occurrence would truncate the target.
  it('anchors on the status separator, not on a dash inside the target', () => {
    const r = parseServerLine('weird: node run.js --flag a - b (stdio) - ✔ Connected');
    expect(r).toMatchObject({ target: 'node run.js --flag a - b', state: 'connected' });
  });

  it('maps the failure and pending markers', () => {
    expect(parseServerLine('a: x - ✘ Failed to connect')?.state).toBe('failed');
    expect(parseServerLine('b: y - ⏸ Pending approval')?.state).toBe('pending');
  });

  it('ignores noise lines', () => {
    expect(parseServerLine('')).toBeNull();
    expect(parseServerLine('Checking MCP server health…')).toBeNull();
  });
});

describe('parseList', () => {
  const parsed = parseList(fix('list.txt'));

  it('finds every server and none of the prose', () => {
    expect(parsed.servers.map((s) => s.name)).toEqual([
      'claude.ai Figma', 'claude.ai Datadog', 'claude.ai Linear', 'hooked', 'incident_io', 'mcp-gateway',
    ]);
  });

  it('keeps the diagnostics block but drops its static help footer', () => {
    expect(parsed.diagnostics.join('\n')).toContain('[Conflicting scopes]');
    expect(parsed.diagnostics.join('\n')).not.toContain('For help configuring MCP servers');
  });

  it('does not mistake a diagnostics line for a server', () => {
    expect(parsed.servers.some((s) => s.name.startsWith('['))).toBe(false);
  });
});

describe('parseGet', () => {
  it('reads the detail fields of an http server', () => {
    expect(parseGet([
      'mcp-gateway:', '  Scope: User config (available in all your projects)',
      '  Status: ✔ Connected', '  Type: http', '  URL: https://gw.example.com/mcp',
    ].join('\n'))).toEqual({
      scopeLabel: 'User config (available in all your projects)',
      status: 'Connected', type: 'http', url: 'https://gw.example.com/mcp',
    });
  });

  // A stdio server registered without an explicit type prints no Type: line at all.
  it('tolerates a missing Type line', () => {
    const d = parseGet('incident_io:\n  Scope: User config\n  Status: ✔ Connected\n');
    expect(d.type).toBeUndefined();
    expect(d.status).toBe('Connected');
  });
});

describe('login output', () => {
  it('extracts the URL from a claude.ai connector flow, and knows it needs no paste', () => {
    const out = fix('login-connector.txt');
    expect(parseAuthUrl(out)).toBe(
      'https://claude.ai/api/organizations/abc/mcp/start-auth/mcpsrv_01?product_surface=sdk-ts');
    expect(wantsPaste(out)).toBe(false);
  });

  it('detects the paste prompt of a plain OAuth server', () => {
    const out = fix('login-oauth.txt');
    expect(parseAuthUrl(out)).toBe('https://auth.example.com/oauth/authorize?client_id=x');
    expect(wantsPaste(out)).toBe(true);
  });
});

describe('readScopes', () => {
  it('ranks local over project over user, and leaves unknown servers to the connector default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-mcp-'));
    const cfg = path.join(dir, 'claude.json');
    fs.writeFileSync(cfg, JSON.stringify({
      mcpServers: { onlyUser: {}, shared: {} },
      projects: { [dir]: { mcpServers: { shared: {} } } },
    }));
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { fromProject: {} } }));

    const scopes = readScopes(dir, cfg);
    expect(scopes.get('onlyUser')).toBe('user');
    expect(scopes.get('fromProject')).toBe('project');
    expect(scopes.get('shared')).toBe('local');

    const rows = decorate([
      { name: 'onlyUser', transport: 'stdio' },
      { name: 'ghost', transport: 'http' },
    ], scopes);
    expect(rows[0]).toMatchObject({ scope: 'user', scopeLabel: 'User', authable: false });
    expect(rows[1]).toMatchObject({ scope: 'connector', scopeLabel: 'claude.ai', authable: true });
  });
});
