/*
 * MCP lens pour le provider vibe : liste des serveurs MCP déclarés dans la config Vibe
 * (~/.vibe/config.toml + <cwd>/.vibe/config.toml), même shape que server/mcp.js
 * ({ servers: [{ name, target, transport, state, status, scope }], diagnostics }).
 *
 * Health check léger : les transports http/streamable-http/sse passent par un fetch (timeout 4s) ;
 * stdio reste « configured » (pas de spawn health-check, trop coûteux).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VIBE_HOME = process.env.VIBE_HOME || path.join(os.homedir(), '.vibe');

// Parse TOML minimal des blocs [[mcp_servers]] (name, transport, url, command, args, env, auth).
function parseMcpToml(toml) {
  const servers = [];
  for (const block of String(toml || '').split(/^\[\[/m)) {
    if (!block.startsWith('mcp_servers]]')) continue;
    const get = (key) => {
      const m = block.match(new RegExp('^' + key + '\\s*=\\s*"([^"]+)"', 'm'));
      return m ? m[1] : null;
    };
    const name = get('name');
    if (!name) continue;
    const transport = get('transport') || 'stdio';
    const url = get('url');
    const command = get('command');
    const authType = block.match(/^\[mcp_servers\.auth\][\s\S]*?^type\s*=\s*"([^"]+)"/m)?.[1] || null;
    servers.push({
      name,
      transport,
      target: url || command || '',
      url, command,
      authType,
      scope: null, // posé par l'appelant (user/project)
      state: 'configured', // vocabulaire du front : configured | connected | failed
      status: '',
    });
  }
  return servers;
}

const SCOPE_LABEL = { user: 'User', project: 'Project' };

// Même décoration que server/mcp.js (scopeLabel) pour que le front n'ait qu'une shape.
function decorateVibe(servers) {
  return servers.map((s) => ({
    ...s,
    scopeLabel: SCOPE_LABEL[s.scope] || s.scope || '',
    authable: false, // pas de flux OAuth pilotable depuis Hooked côté Vibe
  }));
}

function readToml(fp) {
  try { return fs.readFileSync(fp, 'utf8'); } catch (_) { return ''; }
}

async function healthCheck(srv) {
  if (!srv.url) return { state: 'configured', status: 'stdio — not health-checked' };
  // Vrai handshake MCP (comme `claude mcp list` côté claude) : POST initialize streamable-HTTP.
  // Un simple HEAD ne suffit pas — certains serveurs ne répondent qu'au POST du protocole.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(srv.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hooked', version: '0.0.0' } } }),
      signal: ctrl.signal,
    }).catch(() => null);
    clearTimeout(t);
    if (!res) return { state: 'failed', status: 'unreachable' };
    if (res.ok) {
      // serverInfo si le corps JSON est lisible (SSE: on se contente du 200).
      let info = '';
      try {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const j = await res.json();
          const si = j?.result?.serverInfo;
          if (si) info = ` — ${si.name}${si.version ? ' ' + si.version : ''}`;
        }
      } catch (_) {}
      return { state: 'connected', status: `Connected${info}` };
    }
    return { state: 'failed', status: `HTTP ${res.status}` };
  } catch (_) {
    return { state: 'failed', status: 'timeout/unreachable' };
  }
}

// Liste des serveurs MCP Vibe pour un projet : user (<home>/config.toml) + project (<cwd>/.vibe/config.toml).
async function listMcpVibe(cwd, { check = false, home = VIBE_HOME } = {}) {
  const servers = [];
  const diagnostics = [];
  for (const s of parseMcpToml(readToml(path.join(home, 'config.toml')))) {
    servers.push({ ...s, scope: 'user' });
  }
  if (cwd) {
    const proj = parseMcpToml(readToml(path.join(cwd, '.vibe', 'config.toml')));
    for (const s of proj) {
      const existing = servers.find((x) => x.name === s.name);
      if (existing) { diagnostics.push(`"${s.name}" defined in both user and project config — project wins`); servers.splice(servers.indexOf(existing), 1); }
      servers.push({ ...s, scope: 'project' });
    }
  }
  if (check) {
    await Promise.all(servers.map(async (s) => Object.assign(s, await healthCheck(s))));
  }
  return { servers: decorateVibe(servers), diagnostics, checkedAt: Date.now() };
}

export { listMcpVibe, parseMcpToml };
