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
import { parseMcpServersToml } from './piToml.js';

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
// pi 1.6 ne le lit plus ("pi mcp list" répond « No MCP servers configured »), donc ces entrées
// sont mortes : on les liste avec state 'legacy' pour que la lentille propose de les migrer.
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
    status: `in ${path.basename(fp)} — ignoré par pi 1.6`,
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
  // Legacy TOML : listés seulement s'ils ne sont pas déjà migrés dans un mcp.json.
  const legacyByName = new Map();
  for (const s of parseLegacyToml(PI_CONFIG_TOML, 'user')) legacyByName.set(s.name, s);
  if (dir) {
    for (const s of parseLegacyToml(path.join(dir, '.pi', 'config.toml'), 'project')) legacyByName.set(s.name, s);
  }
  for (const [name, s] of legacyByName) if (!byName.has(name)) byName.set(name, s);
  let servers = decoratePi([...byName.values()]);
  if (check) {
    servers = await Promise.all(servers.map(async (s) => ((s.state === 'disabled' || s.state === 'legacy')
      ? s // désactivé ou legacy : pas de health-check
      : { ...s, ...(await healthCheck(s)) })));
  }
  const diagnostics = [];
  const legacy = servers.filter((s) => s.state === 'legacy');
  if (legacy.length) {
    diagnostics.push(`${legacy.length} serveur(s) dans un ancien config.toml (ignoré par pi 1.6) — migrez-les vers ${userFile}`);
  } else if (!fs.existsSync(userFile)) {
    diagnostics.push(`no user mcp.json at ${userFile}`);
  }
  return { servers, diagnostics, cwd: dir, checkedAt: check ? new Date().toISOString() : null };
}

// Migre les [[mcp.servers]] des config.toml (user + project, project gagne) vers le mcp.json
// user, SANS écraser les entrées déjà présentes (un mcp.json actuel gagne sur le legacy).
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
    if (servers[name]) continue; // déjà migré / défini dans mcp.json
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

// Détails d'un serveur, project scope prioritaire sur user (comme au listing). Un serveur
// legacy (config.toml) n'a pas de mcp.json : on retombe sur son bloc TOML.
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

export { listMcpPi };
