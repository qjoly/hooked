// hooked as its own MCP client of the Grafana gateway, so a chart can be re-queried and refreshed
// without a Claude turn. The gateway is the `mcp-gateway` entry of ~/.claude.json; hooked signs in
// to it once through the browser (OAuth, dynamic client registration + PKCE) and keeps its own
// tokens: the CLI's credentials are never read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOOKED_DIR } from './config.js';
import { parseQueryResult } from './queryResult.js';

const STORE = path.join(HOOKED_DIR, 'grafana-gateway.json');
const PROTOCOL = '2025-06-18';
const g = (globalThis.__hookedGrafana ??= { pending: new Map(), session: null, rpcId: 0 });

export function gatewayUrl() {
  if (process.env.HOOKED_GRAFANA_MCP_URL) return process.env.HOOKED_GRAFANA_MCP_URL;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    return j?.mcpServers?.['mcp-gateway']?.url || null;
  } catch (_) { return null; }
}

const readStore = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (_) { return {}; } };
function writeStore(s) {
  fs.mkdirSync(HOOKED_DIR, { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

export class LoginRequired extends Error {
  constructor() { super('hooked is not connected to mcp-gateway'); this.login = true; }
}

// The gateway authorizes on the `groups` claim and the `mcp:tools` scope, which only the resource
// metadata lists: asking for the authorization server's scopes alone gets a token it then refuses.
async function scopes(url) {
  let listed = [];
  try {
    const r = await fetch(new URL('/.well-known/oauth-protected-resource', url));
    if (r.ok) listed = (await r.json()).scopes_supported || [];
  } catch (_) {}
  return [...new Set([...(listed.length ? listed : ['openid', 'profile', 'email', 'groups', 'mcp:tools']), 'offline_access'])].join(' ');
}

async function metadata(url) {
  const r = await fetch(new URL('/.well-known/oauth-authorization-server', url));
  if (!r.ok) throw new Error(`mcp-gateway OAuth metadata: HTTP ${r.status}`);
  return r.json();
}

export function status() {
  const url = gatewayUrl();
  const s = readStore();
  return { url, connected: !!(url && s.url === url && s.tokens?.refresh_token) };
}

// Starts a sign-in: the browser opens the returned URL and comes back to `redirectUri`.
export async function loginUrl(redirectUri) {
  const url = gatewayUrl();
  if (!url) throw new Error('No mcp-gateway server in ~/.claude.json');
  const meta = await metadata(url);
  const s = readStore();
  if (s.url !== url) Object.assign(s, { url, clients: {}, tokens: null });
  s.clients ??= {};
  if (!s.clients[redirectUri]) {
    const r = await fetch(meta.registration_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'hooked', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      }),
    });
    if (!r.ok) throw new Error(`mcp-gateway client registration: HTTP ${r.status}`);
    s.clients[redirectUri] = (await r.json()).client_id;
    writeStore(s);
  }
  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  g.pending.set(state, { verifier, redirectUri, clientId: s.clients[redirectUri], at: Date.now() });
  const u = new URL(meta.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: s.clients[redirectUri], redirect_uri: redirectUri, state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    scope: await scopes(url), resource: url,
  }).toString();
  return u.toString();
}

async function tokenRequest(body) {
  const meta = await metadata(gatewayUrl());
  const r = await fetch(meta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
  });
  if (!r.ok) throw new Error(`mcp-gateway token: HTTP ${r.status}`);
  const t = await r.json();
  const s = readStore();
  s.tokens = {
    access_token: t.access_token,
    refresh_token: t.refresh_token || s.tokens?.refresh_token,
    expires_at: Date.now() + (t.expires_in || 3600) * 1000,
    client_id: body.client_id,
  };
  writeStore(s);
  g.session = null;
  return s.tokens;
}

export async function finishLogin(state, code) {
  const p = g.pending.get(state);
  g.pending.delete(state);
  if (!p || Date.now() - p.at > 10 * 60_000) throw new Error('Sign-in expired, start it again from hooked');
  await tokenRequest({
    grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier,
  });
}

async function accessToken({ force = false } = {}) {
  const t = readStore().tokens;
  if (!t?.refresh_token) throw new LoginRequired();
  if (!force && t.access_token && t.expires_at - 60_000 > Date.now()) return t.access_token;
  try {
    return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id })).access_token;
  } catch (_) { throw new LoginRequired(); }
}

// The reply of a streamable HTTP POST is either plain JSON or an SSE stream carrying it.
export function rpcReply(text, contentType, id) {
  if (!/event-stream/.test(contentType || '')) return text ? JSON.parse(text) : null;
  for (const ev of text.split(/\r?\n\r?\n/)) {
    const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data) continue;
    try { const m = JSON.parse(data); if (m.id === id) return m; } catch (_) {}
  }
  return null;
}

async function post(msg, token) {
  const r = await fetch(gatewayUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`, 'mcp-protocol-version': PROTOCOL,
      ...(g.session ? { 'mcp-session-id': g.session } : {}),
    },
    body: JSON.stringify(msg),
  });
  return { r, text: await r.text() };
}

async function openSession(token) {
  g.session = null;
  const id = ++g.rpcId;
  const { r, text } = await post({ jsonrpc: '2.0', id, method: 'initialize', params: {
    protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'hooked', version: '1' },
  } }, token);
  if (r.status === 401) return false;
  if (!r.ok) throw new Error(`mcp-gateway initialize: HTTP ${r.status}`);
  rpcReply(text, r.headers.get('content-type'), id);
  g.session = r.headers.get('mcp-session-id');
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, token);
  return true;
}

export async function callTool(name, args) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken({ force: attempt > 0 });
    if (!g.session && !(await openSession(token))) continue;
    const id = ++g.rpcId;
    const { r, text } = await post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, token);
    if (r.status === 401 || r.status === 404) { g.session = null; continue; } // expired token or session
    if (!r.ok) throw new Error(`mcp-gateway ${name}: HTTP ${r.status}`);
    const m = rpcReply(text, r.headers.get('content-type'), id);
    if (m?.error) throw new Error(m.error.message || 'mcp-gateway error');
    return (m?.result?.content || []).map((b) => b?.text || '').join('');
  }
  throw new LoginRequired();
}

const UNIT = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
export function durationSec(d) {
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw])$/.exec(String(d || '').trim());
  return m ? Number(m[1]) * UNIT[m[2]] : null;
}

// A spec is { tool: 'prometheus' | 'loki', datasource, query, range? ('6h', ending now) | start/end, step?, limit? }.
export function toolArgs(spec, now = Date.now()) {
  const args = { datasource: String(spec.datasource || ''), query: String(spec.query || '') };
  const range = durationSec(spec.range);
  if (range) {
    args.start = new Date(now - range * 1000).toISOString();
    args.end = new Date(now).toISOString();
  } else {
    if (spec.start) args.start = String(spec.start);
    if (spec.end) args.end = String(spec.end);
  }
  if (spec.step) args.step = String(spec.step);
  if (spec.limit) args.limit = Number(spec.limit);
  return args;
}

export async function runQuery(spec) {
  if (spec?.tool !== 'prometheus' && spec?.tool !== 'loki') throw new Error('tool must be prometheus or loki');
  if (!spec.datasource || !spec.query) throw new Error('datasource and query are required');
  const text = await callTool(`grafana_query_${spec.tool}`, toolArgs(spec));
  let body;
  try { body = JSON.parse(text); } catch (_) { body = { error: text.trim().slice(0, 300) || 'Empty result' }; }
  return parseQueryResult(body);
}
