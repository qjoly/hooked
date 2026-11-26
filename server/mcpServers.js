/*
 * MCP servers that hooked adds to a session, on top of what the CLI finds in the account's own
 * config: some shared by every account, some belonging to one profile.
 *
 * Which servers an account can use is not the same for every account: an organization's servers
 * are not reachable with a personal login, and the claude.ai connectors follow the login. The
 * account's own servers (user scope, in its `.claude.json`) already stay with the account. This is
 * for the rest:
 *
 *   - COMMON servers, in `mcp-common.json` (in the hooked data dir), for every profile that does not
 *     opt out with `"commonMcp": false`, the default one included;
 *   - DEDICATED servers, in a profile's own `mcpServers`, for the sessions of that profile only. A
 *     dedicated server wins over a common one of the same name.
 *
 * Both use the shape of a project's `.mcp.json`, so a block can be copied across:
 *
 *   { "mcpServers": {
 *       "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
 *       "wiki":     { "type": "http", "url": "https://wiki.example.com/mcp",
 *                     "headers": { "Authorization": { "fromEnv": "WIKI_TOKEN" } } } } }
 *
 * `env` and `headers` values are literals or references, resolved when a session starts (cf.
 * server/secretValues.js). They are handed to the Agent SDK's `mcpServers` option, the way hooked's
 * own server already is: nothing is copied into any `.claude.json`, so editing the file takes effect
 * at the next launch, with no drift between accounts. `claude mcp list` does not know servers added
 * this way: the MCP lens lists them itself (cf. describeInjectedMcp).
 *
 * An entry that does not parse is skipped and reported, never fatal, as in profiles.json. A
 * reference that does not resolve is different: the launch is refused with a message naming the
 * server and the variable, rather than starting without a server the user expects.
 *
 * Node stdlib only.
 */
import fs from 'node:fs';
import { MCP_COMMON_FILE } from './config.js';
import { ENV_NAME_RE, isPlainObject, parseSecretValue, resolveSecretMap } from './secretValues.js';

// hooked's own server is added under this name by server/agent.js and must not be shadowed.
export const MCP_RESERVED_NAMES = ['hooked'];

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,128}$/;
const STDIO_KEYS = ['type', 'command', 'args', 'env'];
const HTTP_KEYS = ['type', 'url', 'headers'];

// A { NAME: value-or-reference } map → { map } or { error }.
function parseSecretMap(raw, nameRe, what) {
  if (!isPlainObject(raw)) return { error: `"${what}" must be an object` };
  const map = {};
  for (const [name, v] of Object.entries(raw)) {
    if (!nameRe.test(name)) return { error: `invalid ${what} name ${JSON.stringify(name)}` };
    const r = parseSecretValue(v);
    if (r.error) return { error: `${what} ${name}: ${r.error}` };
    map[name] = r.value;
  }
  return { map };
}

// One server config → { server } (normalized) or { error }. Strict about keys: a typo should be
// reported, not quietly ignored.
function parseServer(raw) {
  if (!isPlainObject(raw)) return { error: 'must be an object' };
  const type = raw.type === undefined ? 'stdio' : raw.type;
  if (type === 'stdio') {
    const stray = Object.keys(raw).find((k) => !STDIO_KEYS.includes(k));
    if (stray) return { error: `unknown key "${stray}" for a stdio server` };
    if (typeof raw.command !== 'string' || !raw.command.trim()) return { error: '"command" is required' };
    const server = { type: 'stdio', command: raw.command };
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string')) return { error: '"args" must be an array of strings' };
      server.args = raw.args;
    }
    if (raw.env !== undefined) {
      const e = parseSecretMap(raw.env, ENV_NAME_RE, 'env');
      if (e.error) return { error: e.error };
      server.env = e.map;
    }
    return { server };
  }
  if (type === 'http' || type === 'sse') {
    const stray = Object.keys(raw).find((k) => !HTTP_KEYS.includes(k));
    if (stray) return { error: `unknown key "${stray}" for a ${type} server` };
    if (typeof raw.url !== 'string' || !/^https?:\/\/\S+$/.test(raw.url)) return { error: '"url" must be an http(s) URL' };
    const server = { type, url: raw.url };
    if (raw.headers !== undefined) {
      const h = parseSecretMap(raw.headers, HEADER_RE, 'headers');
      if (h.error) return { error: h.error };
      server.headers = h.map;
    }
    return { server };
  }
  return { error: '"type" must be "stdio", "http" or "sse"' };
}

// A `{ name: config }` map → { servers, errors }. Pure. A bad entry is skipped and named.
export function parseMcpServerMap(raw) {
  const servers = {};
  const errors = [];
  if (!isPlainObject(raw)) return { servers, errors: ['"mcpServers" must be an object'] };
  for (const [name, cfg] of Object.entries(raw)) {
    if (!NAME_RE.test(name)) { errors.push(`server ${JSON.stringify(name)}: invalid name (letters, digits, "-" and "_", up to 64)`); continue; }
    if (MCP_RESERVED_NAMES.includes(name)) { errors.push(`server "${name}": this name is reserved for hooked's own server`); continue; }
    const r = parseServer(cfg);
    if (r.error) { errors.push(`server "${name}": ${r.error}`); continue; }
    servers[name] = r.server;
  }
  return { servers, errors };
}

// mcp-common.json → { servers, errors }. Read on every call: a few hundred bytes, and an edit then
// shows up at the next launch. A missing file is no servers and no error. Never throws.
export function loadCommonMcp(file = MCP_COMMON_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { servers: {}, errors: [] };
    return { servers: {}, errors: [`cannot read mcp-common.json: ${(e && e.message) || e}`] };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { servers: {}, errors: [`mcp-common.json is not valid JSON: ${(e && e.message) || e}`] };
  }
  if (!isPlainObject(json) || json.mcpServers === undefined) {
    return { servers: {}, errors: ['mcp-common.json must be an object with an "mcpServers" key'] };
  }
  return parseMcpServerMap(json.mcpServers);
}

// The servers a profile gets, before any reference is resolved: the common ones (unless it opted
// out), then its own, which win on a name they share. `sources` says where each came from.
export function mcpServersOf(profile, { file = MCP_COMMON_FILE } = {}) {
  const common = profile && profile.commonMcp === false ? { servers: {}, errors: [] } : loadCommonMcp(file);
  const own = (profile && profile.mcpServers) || {};
  const sources = {};
  for (const name of Object.keys(common.servers)) sources[name] = 'common';
  for (const name of Object.keys(own)) sources[name] = 'profile';
  return { servers: { ...common.servers, ...own }, sources, warnings: common.errors };
}

/**
 * What the SDK's `mcpServers` option gets for a session on `profile`: every reference resolved
 * against the login environment. → { servers, errors, warnings }:
 *   servers   ready to pass to the SDK
 *   errors    references that did not resolve, each naming the server and the variable (never its
 *             value): the caller refuses the launch
 *   warnings  entries of mcp-common.json that were skipped
 * `env`, `file`, `readFile` and `home` are injectable for the tests.
 */
export function injectedMcpFor(profile, { env = process.env, file, readFile, home } = {}) {
  const { servers, warnings } = mcpServersOf(profile, { file });
  const out = {};
  const errors = [];
  for (const [name, s] of Object.entries(servers)) {
    const opts = { env, readFile, home };
    const e = s.env ? resolveSecretMap(s.env, opts) : { values: undefined, errors: [] };
    const h = s.headers ? resolveSecretMap(s.headers, opts) : { values: undefined, errors: [] };
    const bad = [...e.errors, ...h.errors];
    if (bad.length) { errors.push(`MCP server "${name}": ${bad.join('; ')}`); continue; }
    const cfg = { ...s };
    if (e.values) cfg.env = e.values;
    if (h.values) cfg.headers = h.values;
    out[name] = cfg;
  }
  return { servers: out, errors, warnings };
}

// A URL without its query string and credentials: enough to recognise a server, never a token.
function safeUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch (_) { return ''; }
}

/**
 * The injected servers as the MCP lens shows them: no resolution, and nothing secret (the URL
 * loses its query, `env` and `headers` are not shown at all).
 * → { servers: [{ name, transport, scope: 'common' | 'profile', summary }], warnings }
 */
export function describeInjectedMcp(profile, { file } = {}) {
  const { servers, sources, warnings } = mcpServersOf(profile, { file });
  return {
    servers: Object.entries(servers).map(([name, s]) => ({
      name,
      transport: s.type,
      scope: sources[name],
      summary: s.type === 'stdio' ? [s.command, ...(s.args || [])].join(' ') : safeUrl(s.url),
    })),
    warnings,
  };
}
