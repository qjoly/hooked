/*
 * Characterisation tests for the legacy pi config.toml parser (server/piToml.js).
 * The fixture mirrors a real ~/.pi/config.toml (pi < 1.6 format), including the multi-line
 * inline env table and comments.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMcpServersToml } from '../server/piToml.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pi-toml');

describe('parseMcpServersToml', () => {
  it('reads [[mcp.servers]] blocks with command/args/env, multi-line inline table and comments', () => {
    const text = fs.readFileSync(path.join(FIX, 'config.toml'), 'utf8');
    const servers = parseMcpServersToml(text);
    expect(servers.map((s) => s.name)).toEqual(['hooked', 'homeassistant', 'remote']);

    const hooked = servers[0];
    expect(hooked.command).toBe('node');
    expect(hooked.args).toEqual(['/Users/qjoly/code/hooked/mcp/server.cjs']);
    expect(hooked.env).toEqual({ HOOKED_MCP_URL: 'http://localhost:4123' });

    const hass = servers[1];
    expect(hass.command).toBe('npx');
    expect(hass.args).toEqual(['@orellbuehler/homeassistant-mcp']);
    // multi-line inline table
    expect(hass.env.HASS_URL).toBe('https://home.example.eu');
    expect(hass.env.HASS_TOKEN).toBe('secret-token');

    const remote = servers[2];
    expect(remote.url).toBe('https://mcp.example.com/sse');
    expect(remote.type).toBe('http');
    expect(remote.headers).toEqual({ Authorization: 'Bearer x' });
    expect(remote.enabled).toBe(false);
  });

  it('ignores other sections, bare keys outside blocks, and malformed values', () => {
    const servers = parseMcpServersToml(`
[other]
key = "value"

[mcp]
notaserver = true

[[mcp.servers]]
name = "ok"
command = "run"
broken = { unclosed

[[mcp.servers]]
command = "no-name"
`);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('ok');
    expect(servers[0].command).toBe('run');
  });

  it('handles escapes in strings and empty input', () => {
    expect(parseMcpServersToml('')).toEqual([]);
    const [s] = parseMcpServersToml('[[mcp.servers]]\nname = "a\\"b"\ncommand = "c\\\\d"');
    expect(s.name).toBe('a"b');
    expect(s.command).toBe('c\\d');
  });
});
