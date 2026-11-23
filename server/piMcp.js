/*
 * MCP lens pour le provider pi : liste des serveurs MCP déclarés dans ~/.pi/agent/mcp.json
 * (user) + <cwd>/.pi/mcp.json (project, gagne sur doublon), format standard MCP
 * {"mcpServers":{"name":{"command","args","env"} | {"url","headers","type":"http"}}}, cf. docs/port-pi.md.
 * Même shape que server/mcp.js ({ servers: [{ name, target, transport, state, status, scope }], diagnostics }).
 *
 * Health check : les transports http passent par un POST `initialize` streamable-HTTP (timeout 4 s),
 * comme pour vibe ; stdio reste « configured ».
 *
 * Gestion (CRUD) : pi n'a pas de sous-commande `pi mcp add/remove`, les serveurs se gèrent en
 * éditant les mcp.json — c'est ce que font saveMcpPi/removeMcpPi, en écrivant le scope demandé
 * (user → ~/.pi/agent/mcp.json, project → <cwd>/.pi/mcp.json). Écriture atomique (tmp + rename),
 * mode 0600 sur le fichier user : env/headers peuvent contenir des secrets.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { parseMcpServersToml } from './piToml.js';
import { resolvePiBin } from './piAgent.js';

const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
const PI_CONFIG_TOML = path.join(os.homedir(), '.pi', 'config.toml');

function readJson(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { return null; }
}

// Entrées mcpServers d'un fichier mcp.json → [{ name, transport, target, url, command, scope, ... }].
// Un serveur `enabled: false` est listé aussi (state 'disabled') : le gérer depuis le dashboard
// inclut le réactiver, donc le faire disparaître du listing serait un cul-de-sac.
function parseMcpJson(fp, scope) {
  const data = readJson(fp);
  const servers = data && typeof data === 'object' ? data.mcpServers : null;
  if (!servers || typeof servers !== 'object') return [];
  const out = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const isUrl = typeof cfg.url === 'string' && cfg.url;
    const disabled = cfg.enabled === false;
    out.push({
      name,
      transport: isUrl ? (cfg.type === 'stdio' ? 'stdio' : 'http') : 'stdio',
      target: isUrl ? cfg.url : [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])].filter(Boolean).join(' '),
      url: isUrl ? cfg.url : null,
      command: cfg.command || null,
      args: Array.isArray(cfg.args) ? cfg.args : null,
      env: cfg.env && typeof cfg.env === 'object' ? cfg.env : null,
      headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : null,
      enabled: !disabled,
      scope,
      state: disabled ? 'disabled' : 'configured',
      status: disabled ? 'disabled' : '',
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
// pi's own view of its servers: `pi mcp list --json`, run in the session directory so the servers
// of a trusted project count. It connects with pi's OAuth tokens (~/.pi/agent/mcp-auth.json), which
// the bare HTTP probe below does not have: an OAuth server pi is signed in to would look failed
// there. Resolves to Map name -> { state, status, tools }, or null when pi is missing or fails.
const PI_STATES = { connected: 'connected', connecting: 'pending', 'needs-auth': 'needs_auth', error: 'failed', disabled: 'disabled' };

function piMcpStates(cwd, { bin = resolvePiBin(null), timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(bin, ['mcp', 'list', '--json'], { cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(), stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      let j;
      try { j = JSON.parse(out); } catch (_) { return resolve(null); }
      const errors = new Map();
      for (const e of Array.isArray(j.errors) ? j.errors : []) {
        const name = e && (e.server || e.name);
        if (name) errors.set(name, String(e.message || e.error || '').slice(0, 200));
      }
      const map = new Map();
      for (const srv of Array.isArray(j.servers) ? j.servers : []) {
        if (!srv || !srv.name) continue;
        const state = PI_STATES[srv.state] || 'failed';
        const tools = Array.isArray(srv.tools) ? srv.tools.length : null;
        const status = state === 'connected' ? `${tools ?? 0} tools`
          : state === 'needs_auth' ? `sign in with: pi mcp login ${srv.name}`
          : (errors.get(srv.name) || srv.error || srv.state || 'not connected');
        map.set(srv.name, { state, status, tools });
      }
      resolve(map);
    });
  });
}

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

// Ancien format pi (< 1.6) : ~/.pi/config.toml + <cwd>/.pi/config.toml, section [[mcp.servers]].
// pi 1.6 no longer reads it ("pi mcp list" answers "No MCP servers configured"), so these entries
// are dead: they are listed with state 'legacy' so that the lens offers to migrate them.
function parseLegacyToml(fp, scope) {
  let text;
  try { text = fs.readFileSync(fp, 'utf8'); } catch (_) { return []; }
  return parseMcpServersToml(text).map((x) => ({
    name: x.name,
    transport: x.url ? (x.type === 'stdio' ? 'stdio' : 'http') : 'stdio',
    target: x.url || [x.command, ...(x.args || [])].filter(Boolean).join(' '),
    url: x.url || null,
    command: x.command || null,
    args: x.args || null,
    env: x.env || null,
    headers: x.headers || null,
    enabled: x.enabled !== false,
    scope,
    state: 'legacy',
    status: `in ${path.basename(fp)}, ignored by pi 1.6`,
    legacy: true,
  }));
}

async function listMcpPi(cwd, { check = false } = {}) {
  const dir = cwd || '';
  const userFile = path.join(PI_AGENT_DIR, 'mcp.json');
  const projectFile = dir ? path.join(dir, '.pi', 'mcp.json') : null;
  const byName = new Map();
  for (const s of parseMcpJson(userFile, 'user')) byName.set(s.name, s);
  if (projectFile) for (const s of parseMcpJson(projectFile, 'project')) byName.set(s.name, s); // project gagne
  // Legacy TOML: listed only when not already migrated to a mcp.json.
  const legacyByName = new Map();
  for (const s of parseLegacyToml(PI_CONFIG_TOML, 'user')) legacyByName.set(s.name, s);
  if (dir) {
    for (const s of parseLegacyToml(path.join(dir, '.pi', 'config.toml'), 'project')) legacyByName.set(s.name, s);
  }
  for (const [name, s] of legacyByName) if (!byName.has(name)) byName.set(name, s);
  let servers = decoratePi([...byName.values()]);
  if (check) {
    const live = await piMcpStates(dir);
    servers = await Promise.all(servers.map(async (s) => {
      if (s.state === 'disabled' || s.state === 'legacy') return s; // disabled or legacy: no health check
      if (live && live.has(s.name)) return { ...s, ...live.get(s.name) };
      return { ...s, ...(await healthCheck(s)) };
    }));
  }
  const diagnostics = [];
  const legacy = servers.filter((s) => s.state === 'legacy');
  if (legacy.length) {
    diagnostics.push(`${legacy.length} server(s) in an old config.toml (ignored by pi 1.6): migrate them to ${userFile}`);
  } else if (!fs.existsSync(userFile)) {
    diagnostics.push(`no user mcp.json at ${userFile}`);
  }
  return { servers, diagnostics, cwd: dir, checkedAt: check ? new Date().toISOString() : null };
}

// Migrates the [[mcp.servers]] of the config.toml files (user + project, project wins) to the
// user mcp.json, WITHOUT overwriting entries already there (a current mcp.json wins over legacy).
export function migrateLegacyToml({ cwd }) {
  const dir = cwd || '';
  const legacy = new Map();
  for (const s of parseLegacyToml(PI_CONFIG_TOML, 'user')) legacy.set(s.name, s);
  if (dir) for (const s of parseLegacyToml(path.join(dir, '.pi', 'config.toml'), 'project')) legacy.set(s.name, s);
  if (!legacy.size) return { ok: true, migrated: [], file: null };
  const fp = path.join(PI_AGENT_DIR, 'mcp.json');
  const { data, servers } = readServers(fp);
  const migrated = [];
  for (const [name, s] of legacy) {
    if (servers[name]) continue; // already migrated or defined in mcp.json
    const cfg = {};
    if (s.url) {
      cfg.url = s.url;
      if (s.transport === 'http' || s.transport === 'sse') cfg.type = s.transport;
      if (s.headers) cfg.headers = s.headers;
    } else {
      cfg.command = s.command;
      if (s.args) cfg.args = s.args;
      if (s.env) cfg.env = s.env;
    }
    if (s.enabled === false) cfg.enabled = false;
    servers[name] = cfg;
    migrated.push(name);
  }
  if (migrated.length) writeServers(fp, { ...data, mcpServers: servers }, { secret: true });
  return { ok: true, migrated, file: migrated.length ? fp : null };
}

// ---------- gestion (CRUD) des mcp.json ----------

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function fileForScope(scope, cwd) {
  if (scope === 'user') return path.join(PI_AGENT_DIR, 'mcp.json');
  if (scope === 'project') {
    const dir = cwd && String(cwd).trim();
    if (!dir) throw new Error('project scope needs a cwd');
    return path.join(dir, '.pi', 'mcp.json');
  }
  throw new Error(`unknown scope: ${scope}`);
}

function readServers(fp) {
  const data = readJson(fp);
  const servers = data && typeof data === 'object' && data.mcpServers && typeof data.mcpServers === 'object'
    ? data.mcpServers : {};
  // On ne réécrit que mcpServers : un mcp.json peut porter d'autres clés, on les préserve.
  return { data: data && typeof data === 'object' ? data : {}, servers: { ...servers } };
}

function writeServers(fp, data, { secret = false } = {}) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', secret ? { mode: 0o600 } : undefined);
  fs.renameSync(tmp, fp);
}

// Ne garde que les champs reconnus d'une config MCP, dans un ordre stable. Soit `url` (http),
// soit `command` (stdio) — un mélange des deux n'a pas de sens.
function cleanConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('config must be an object');
  const out = {};
  const isUrl = typeof cfg.url === 'string' && /^https?:\/\//i.test(cfg.url);
  if (isUrl) {
    out.url = cfg.url;
    if (cfg.type === 'stdio') out.type = 'stdio';
    else if (cfg.type === 'http' || cfg.type === 'sse') out.type = cfg.type;
    if (cfg.headers && typeof cfg.headers === 'object') out.headers = { ...cfg.headers };
  } else {
    if (typeof cfg.command !== 'string' || !cfg.command.trim()) throw new Error('config needs a url (http) or a command (stdio)');
    out.command = cfg.command;
    if (Array.isArray(cfg.args)) out.args = cfg.args.map(String);
    if (cfg.env && typeof cfg.env === 'object') out.env = Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, String(v)]));
  }
  if (cfg.enabled === false) out.enabled = false;
  return out;
}

// Details of one server, the project scope winning over user (as in the listing). A legacy
// server (config.toml) has no mcp.json: its TOML block is used instead.
export function getMcpPi(cwd, name) {
  for (const scope of ['project', 'user']) {
    const fp = fileForScope(scope, cwd);
    const { servers } = readServers(fp);
    if (servers[name]) {
      const [s] = parseMcpJson(fp, scope).filter((x) => x.name === name);
      return { ok: true, name, scope, ...s, raw: servers[name] };
    }
  }
  const legacy = parseLegacyToml(PI_CONFIG_TOML, 'user').find((x) => x.name === name)
    || (cwd ? parseLegacyToml(path.join(cwd, '.pi', 'config.toml'), 'project').find((x) => x.name === name) : null);
  if (legacy) return { ok: true, name, scope: legacy.scope, ...legacy, raw: legacy };
  return { ok: false, error: `no MCP server named ${name}` };
}

// Crée ou remplace un serveur dans le scope demandé. `config: null` = suppression (alias de remove).
export function saveMcpPi({ cwd, scope = 'project', name, config }) {
  if (!name || !NAME_RE.test(String(name))) throw new Error('invalid server name');
  const fp = fileForScope(scope, cwd);
  const { data, servers } = readServers(fp);
  if (config === null || config === undefined) delete servers[name];
  else servers[name] = cleanConfig(config);
  const out = { ...data, mcpServers: servers };
  writeServers(fp, out, { secret: scope === 'user' });
  const [s] = parseMcpJson(fp, scope).filter((x) => x.name === name);
  return { ok: true, name, scope, server: s || null, file: fp };
}

export function removeMcpPi({ cwd, scope, name }) {
  if (!name || !NAME_RE.test(String(name))) throw new Error('invalid server name');
  const fp = fileForScope(scope, cwd);
  const { data, servers } = readServers(fp);
  if (!(name in servers)) return { ok: false, error: `no MCP server named ${name} in ${scope} scope` };
  delete servers[name];
  writeServers(fp, { ...data, mcpServers: servers }, { secret: scope === 'user' });
  return { ok: true, name, scope, file: fp };
}

export { listMcpPi, piMcpStates };
