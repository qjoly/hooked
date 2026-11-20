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

  it('listMcpVibe lit user + project, le projet gagne, shape décorée comme mcp.js', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-proj-'));
    fs.writeFileSync(path.join(home, 'config.toml'), TOML + '\n[[mcp_servers]]\nname = "only-user"\ntransport = "stdio"\ncommand = "x"\n');
    fs.mkdirSync(path.join(cwd, '.vibe'));
    fs.writeFileSync(path.join(cwd, '.vibe', 'config.toml'), '[[mcp_servers]]\nname = "fs"\ntransport = "stdio"\ncommand = "proj-fs"\n');
    try {
      const res = await listMcpVibe(cwd, { home });
      const byName = Object.fromEntries(res.servers.map((s) => [s.name, s]));
      expect(Object.keys(byName).sort()).toEqual(['fs', 'linear', 'only-user']);
      expect(byName['fs'].target).toBe('proj-fs'); // le projet gagne
      expect(res.diagnostics.some((d) => d.includes('"fs"'))).toBe(true);
      // shape front (Mcp.svelte) : scopeLabel + authable + états connus
      expect(byName['linear'].scopeLabel).toBe('User');
      expect(byName['fs'].scopeLabel).toBe('Project');
      expect(byName['linear'].authable).toBe(false);
      expect(byName['linear'].state).toBe('configured');
      expect(typeof res.checkedAt).toBe('number');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('vibeMcp — healthCheck HTTP (vrai handshake initialize)', () => {
  it('connected avec serverInfo sur 200, failed sur 4xx/5xx, unreachable sinon', async () => {
    const http = await import('node:http');
    const { listMcpVibe } = await import('../server/index.js');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const srv = http.createServer((req, res) => {
      if (req.url === '/bad') { res.writeHead(500); return res.end(); }
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test-mcp', version: '1.2.3' } } }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-home-'));
    fs.writeFileSync(path.join(home, 'config.toml'), `
[[mcp_servers]]
name = "ok"
transport = "http"
url = "http://127.0.0.1:${port}/mcp"

[[mcp_servers]]
name = "ko"
transport = "http"
url = "http://127.0.0.1:${port}/bad"

[[mcp_servers]]
name = "down"
transport = "http"
url = "http://127.0.0.1:1/mcp"
`);
    try {
      const res = await listMcpVibe(null, { home, check: true });
      const by = Object.fromEntries(res.servers.map((x) => [x.name, x]));
      expect(by.ok.state).toBe('connected');
      expect(by.ok.status).toContain('test-mcp 1.2.3'); // serverInfo remonté
      expect(by.ko.state).toBe('failed');
      expect(by.ko.status).toBe('HTTP 500');
      expect(by.down.state).toBe('failed');
      expect(by.down.status).toBe('unreachable');
    } finally {
      srv.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
