/*
 * MCP lens pour le provider pi : liste des serveurs MCP déclarés dans ~/.pi/agent/mcp.json
 * (user) + <cwd>/.pi/mcp.json (project, gagne sur doublon), format standard MCP
 * {"mcpServers":{"name":{"command","args","env"} | {"url","headers","type":"http"}}}, cf. docs/port-pi.md.
 * Même shape que server/mcp.js ({ servers: [{ name, target, transport, state, status, scope }], diagnostics }).
 *
 * Health check : les transports http passent par un POST `initialize` streamable-HTTP (timeout 4 s),
 * comme pour vibe ; stdio reste « configured ».
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');

function readJson(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { return null; }
}

// Entrées mcpServers d'un fichier mcp.json → [{ name, transport, target, url, command, scope }]
function parseMcpJson(fp, scope) {
  const data = readJson(fp);
  const servers = data && typeof data === 'object' ? data.mcpServers : null;
  if (!servers || typeof servers !== 'object') return [];
  const out = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (cfg.enabled === false) continue;
    const isUrl = typeof cfg.url === 'string' && cfg.url;
    out.push({
      name,
      transport: isUrl ? (cfg.type === 'stdio' ? 'stdio' : 'http') : 'stdio',
      target: isUrl ? cfg.url : [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])].filter(Boolean).join(' '),
      url: isUrl ? cfg.url : null,
      command: cfg.command || null,
      scope,
      state: 'configured',
      status: '',
    });
  }
  return out;
}

const SCOPE_LABEL = { user: 'User', project: 'Project' };

function decoratePi(servers) {
  return servers.map((s) => ({
    ...s,
    scopeLabel: SCOPE_LABEL[s.scope] || s.scope || '',
    authable: false,
  }));
}

// Health check streamable-HTTP : vrai handshake MCP (initialize), comme côté vibe.
async function healthCheck(srv) {
  if (!srv.url) return { state: 'configured', status: 'stdio — not health-checked' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4_000);
    const r = await fetch(srv.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-03-26',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'hooked', version: '0.1.0' },
        },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (r.ok) return { state: 'connected', status: `HTTP ${r.status}` };
    return { state: 'failed', status: `HTTP ${r.status}` };
  } catch (e) {
    return { state: 'failed', status: String(e && e.message || e).slice(0, 120) };
  }
}

async function listMcpPi(cwd, { check = false } = {}) {
  const userFile = path.join(PI_AGENT_DIR, 'mcp.json');
  const projectFile = cwd ? path.join(cwd, '.pi', 'mcp.json') : null;
  const byName = new Map();
  for (const s of parseMcpJson(userFile, 'user')) byName.set(s.name, s);
  if (projectFile) for (const s of parseMcpJson(projectFile, 'project')) byName.set(s.name, s); // project gagne
  let servers = decoratePi([...byName.values()]);
  if (check) {
    servers = await Promise.all(servers.map(async (s) => ({ ...s, ...(await healthCheck(s)) })));
  }
  const diagnostics = [];
  if (!fs.existsSync(userFile)) diagnostics.push(`no user mcp.json at ${userFile}`);
  return { servers, diagnostics, checkedAt: check ? new Date().toISOString() : null };
}

export { listMcpPi };
