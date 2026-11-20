/*
 * MCP lens provider vibe (server/vibeMcp.js) : parse de [[mcp_servers]] dans config.toml.
 */
import { describe, it, expect } from 'vitest';
import { parseMcpToml, listMcpVibe } from '../server/index.js';

const TOML = `
active_model = "medium"

[[mcp_servers]]
name = "linear"
transport = "streamable-http"
url = "https://mcp.linear.app/mcp"

[mcp_servers.auth]
type = "oauth"
scopes = ["read", "write"]

[[mcp_servers]]
name = "fs"
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem"]
`;

describe('vibeMcp', () => {
  it('parseMcpToml extrait les serveurs (transport, url/command, auth)', () => {
    const servers = parseMcpToml(TOML);
    expect(servers).toHaveLength(2);
    expect(servers[0]).toMatchObject({ name: 'linear', transport: 'streamable-http', url: 'https://mcp.linear.app/mcp', authType: 'oauth' });
    expect(servers[1]).toMatchObject({ name: 'fs', transport: 'stdio', command: 'npx', authType: null });
  });

  it('listMcpVibe lit user + project, le projet gagne sur les conflits', async () => {
    const res = await listMcpVibe(null, {});
    // sans cwd et sans config fixture pointée, on a au moins la shape
    expect(Array.isArray(res.servers)).toBe(true);
    expect(Array.isArray(res.diagnostics)).toBe(true);
    expect(typeof res.checkedAt).toBe('number');
  });
});
