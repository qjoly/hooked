/*
 * MCP servers — list, health, and OAuth (re)authentication, driven from the dashboard.
 *
 * Why this module exists: `/mcp` is a TUI screen of the Claude Code CLI. Sessions now run through
 * the Agent SDK inside the hooked process, so there is no interactive terminal to open it in —
 * a server that drops to "Needs authentication" became impossible to fix from hooked. This is that
 * screen, rebuilt on the CLI's non-interactive `claude mcp` subcommands.
 *
 * Two deliberate choices:
 *
 *   - We PARSE `claude mcp list` rather than read the config files. It is the only source that
 *     health-checks every server AND sees claude.ai connectors, which live on the account, not on
 *     disk. It has no JSON mode, so the parsers below are pinned by fixtures (test/mcp.test.mjs) —
 *     the output format is the contract, and a CLI upgrade that breaks it breaks a test rather than
 *     the page. Scope, in contrast, IS read from disk: deriving it costs nothing, where
 *     `claude mcp get` would mean one extra health-checked spawn per server.
 *
 *   - Login runs under a real PTY (node-pty), not `spawn`. `claude mcp login` writes the
 *     authorization URL through a terminal — OSC-8 hyperlinks, ANSI colour, cursor codes — and, for
 *     a plain OAuth server, then WAITS on stdin for the redirect URL to be pasted back. Without a
 *     tty it degrades or exits early. The PTY keeps that process alive between the two HTTP calls
 *     (start the login, paste the redirect back), which is why logins live in a registry.
 *
 * `--no-browser` is always passed, even though hooked is usually local: the browser must open on
 * the machine LOOKING at the dashboard, not the one running it. We surface the URL as a link and
 * let the user's own browser handle it, which also makes remote-control setups work. When the two
 * are the same machine the OAuth callback still lands on localhost and the CLI finishes by itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { HOME } from './config.js';
import { resolveClaudeBin } from './commands.js';
import { loginEnv } from './agent.js';

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 60_000;
const MAX_LOGINS = 4;

// Same reason as the session and terminal registries: Vite re-executes server modules on edit in
// `npm run live`, and a fresh Map would orphan the PTY of a login already in flight.
const REGISTRY = Symbol.for('hooked.mcp.logins');
/** @type {Map<string, any>} */
const logins = globalThis[REGISTRY] || (globalThis[REGISTRY] = new Map());

// ---------- pure parsers (fixture-tested, no CLI needed) ----------

// Not agent.js's stripAnsi: that one only strips CSI. OSC-8 hyperlinks wrap the URL in an
// invisible escape that repeats it, so stripping colour alone leaves the URL twice on the line.
const OSC8 = /\u001b\]8;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI = /\u001b\[[0-9;?]*[a-zA-Z]/g;

export function stripCliAnsi(s) {
  return String(s || '').replace(OSC8, '').replace(CSI, '').replace(/\r/g, '');
}

const STATES = [
  { sym: '✔', state: 'connected' },
  { sym: '✓', state: 'connected' },
  { sym: '!', state: 'needs_auth' },
  { sym: '⏸', state: 'pending' },
  { sym: '✘', state: 'failed' },
  { sym: '✗', state: 'failed' },
  { sym: '×', state: 'failed' },
];

// One server line: "<name>: <target> - <sym> <status text>". Both halves are ambiguous on their
// own (targets contain ":" and " - " freely), so anchor on the LAST " - " that is followed by a
// known status symbol, then take the FIRST ": " before it.
export function parseServerLine(line) {
  const s = stripCliAnsi(line).trim();
  if (!s) return null;
  let from = s.length;
  while (from >= 0) {
    const at = s.lastIndexOf(' - ', from);
    if (at < 0) return null;
    const rest = s.slice(at + 3).trim();
    const hit = STATES.find((x) => rest.startsWith(x.sym));
    if (!hit) { from = at - 1; continue; }
    const head = s.slice(0, at);
    const colon = head.indexOf(': ');
    if (colon < 0) return null;
    const name = head.slice(0, colon).trim();
    if (!name) return null;
    let target = head.slice(colon + 2).trim();
    let transport = null;
    const tm = target.match(/\s*\((HTTP|SSE|stdio)\)$/i);
    if (tm) { transport = tm[1].toLowerCase(); target = target.slice(0, tm.index).trim(); }
    if (!transport) transport = /^https?:\/\//i.test(target) ? 'http' : 'stdio';
    return { name, target, transport, state: hit.state, status: rest.slice(hit.sym.length).trim() };
  }
  return null;
}

// Full `claude mcp list` output -> { servers, diagnostics }. The diagnostics block is everything
// from the "MCP config diagnostics" heading on: conflicting scopes, unreadable configs. It is real
// signal (a server authenticated in the wrong scope looks fine yet never carries its token), so we
// keep it verbatim rather than dropping it.
export function parseList(out) {
  const lines = stripCliAnsi(out).split('\n');
  const servers = [];
  const diagnostics = [];
  let inDiag = false;
  for (const line of lines) {
    if (/^MCP config diagnostics/.test(line.trim())) { inDiag = true; continue; }
    if (inDiag) {
      const t = line.replace(/\s+$/, '');
      // Static footer, printed whether or not anything is actually wrong.
      if (t.trim() && !/^For help configuring MCP servers/.test(t.trim())) diagnostics.push(t);
      continue;
    }
    const srv = parseServerLine(line);
    if (srv) servers.push(srv);
  }
  return { servers, diagnostics };
}

// `claude mcp get <name>` -> the detail fields. Tolerant by design: a stdio server registered
// without an explicit type prints no "Type:" line at all.
export function parseGet(out) {
  const d = {};
  for (const raw of stripCliAnsi(out).split('\n')) {
    const m = raw.match(/^\s{2}([A-Za-z ]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const val = m[2].trim();
    if (key === 'scope') d.scopeLabel = val;
    else if (key === 'status') d.status = val.replace(/^[^A-Za-z]+/, '').trim();
    else if (key === 'type') d.type = val.toLowerCase();
    else if (key === 'url') d.url = val;
    else if (key === 'command') d.command = val;
    else if (key === 'args') d.args = val;
    else if (key === 'environment') d.env = val;
  }
  return d;
}

// The authorization URL the login flow prints. Taken from the LAST match: the CLI echoes progress
// lines that may themselves carry a docs URL.
export function parseAuthUrl(out) {
  const m = stripCliAnsi(out).match(/https?:\/\/[^\s"'<>]+/g);
  return m && m.length ? m[m.length - 1] : null;
}

// Does the process still want the redirect URL pasted back? A claude.ai connector finishes on the
// website and exits; a plain OAuth server prints a paste prompt and blocks on stdin.
export function wantsPaste(out) {
  const s = stripCliAnsi(out);
  if (/next time you start Claude Code/i.test(s)) return false;
  return /paste|redirect url|callback url/i.test(s);
}

// ---------- scope, from disk ----------

// Where a server is defined, without spending a health-checked `claude mcp get` per server.
// Precedence matches the CLI's own: local (this project, private) > project (.mcp.json, shared) >
// user (all projects). Anything the CLI lists that no config declares is a claude.ai connector.
export function readScopes(cwd, claudeJsonPath = null) {
  const scopes = new Map();
  const claudeJson = claudeJsonPath || process.env.HOOKED_CLAUDE_JSON
    || path.join(process.env.CLAUDE_CONFIG_DIR || HOME, '.claude.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(claudeJson, 'utf8')); } catch (_) { cfg = {}; }
  for (const name of Object.keys(cfg.mcpServers || {})) scopes.set(name, 'user');
  try {
    const proj = JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8'));
    for (const name of Object.keys(proj.mcpServers || {})) scopes.set(name, 'project');
  } catch (_) { /* no .mcp.json here */ }
  const local = ((cfg.projects || {})[cwd] || {}).mcpServers || {};
  for (const name of Object.keys(local)) scopes.set(name, 'local');
  return scopes;
}

const SCOPE_LABEL = { user: 'User', project: 'Project', local: 'Local', connector: 'claude.ai' };

// Decorate parsed servers with scope + whether they can hold OAuth credentials. A stdio server has
// none, so offering Reauth on it would be a dead button.
export function decorate(servers, scopes) {
  return servers.map((s) => {
    const scope = scopes.get(s.name) || 'connector';
    const authable = s.transport !== 'stdio' || scope === 'connector';
    return { ...s, scope, scopeLabel: SCOPE_LABEL[scope], authable };
  });
}

// ---------- CLI runners ----------

function claudeBin() {
  const bin = resolveClaudeBin();
  if (!bin) throw new Error('claude binary not found');
  return bin;
}

// Every claude invocation gets the login shell's environment, for the same reason sessions do
// (server/agent.js): under launchd the service PATH is frozen at install time, and the CLI needs
// its real one to reach node, the keychain helper and the OAuth opener.
export async function runClaude(args, cwd, timeout = LIST_TIMEOUT_MS) {
  const env = await loginEnv();
  return new Promise((resolve) => {
    cp.execFile(claudeBin(), args, {
      cwd, env: { ...process.env, ...env }, timeout, encoding: 'utf8', maxBuffer: 4 << 20,
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '') + String(stderr || ''), stdout: String(stdout || ''), code: err ? (err.code ?? 1) : 0 });
    });
  });
}

export function validCwd(cwd) {
  const dir = cwd && String(cwd).trim() ? String(cwd) : HOME;
  try { if (fs.statSync(dir).isDirectory()) return dir; } catch (_) { /* fall through */ }
  return HOME;
}

export async function listMcp(cwd) {
  const dir = validCwd(cwd);
  if (!resolveClaudeBin()) {
    return { cwd: dir, servers: [], diagnostics: [], error: 'claude binary not found' };
  }
  const { out } = await runClaude(['mcp', 'list'], dir);
  const { servers, diagnostics } = parseList(out);
  return { cwd: dir, diagnostics, servers: decorate(servers, readScopes(dir)) };
}

export async function getMcp(cwd, name) {
  const dir = validCwd(cwd);
  const { out, ok } = await runClaude(['mcp', 'get', String(name)], dir);
  return { ok, name, detail: parseGet(out), raw: stripCliAnsi(out).trim() };
}

export async function logoutMcp(cwd, name) {
  const dir = validCwd(cwd);
  const { ok, out } = await runClaude(['mcp', 'logout', String(name)], dir, 30_000);
  return { ok, message: stripCliAnsi(out).trim() };
}

// ---------- login (PTY) ----------

let ptyMod = null;
async function loadPty() {
  if (ptyMod) return ptyMod;
  ptyMod = await import('node-pty');
  return ptyMod;
}

function snapshot(entry) {
  return {
    id: entry.id,
    name: entry.name,
    url: entry.url,
    done: entry.done,
    exitCode: entry.exitCode,
    needsPaste: !entry.done && wantsPaste(entry.buf),
    // A claude.ai connector exits as soon as it has printed the URL: approval happens on the
    // website afterwards, so "the process ended" must NOT be reported as "you are authenticated".
    outOfBand: /next time you start Claude Code/i.test(stripCliAnsi(entry.buf)),
    output: stripCliAnsi(entry.buf).slice(-4000),
  };
}

function finish(entry, exitCode) {
  if (entry.done) return;
  entry.done = true;
  entry.exitCode = exitCode;
  clearTimeout(entry.timer);
}

export async function startLogin(cwd, name) {
  const dir = validCwd(cwd);
  if (!name || typeof name !== 'string') throw new Error('name required');
  for (const [id, e] of logins) if (e.done && Date.now() - e.startedAt > 5 * 60_000) logins.delete(id);
  if (logins.size >= MAX_LOGINS) throw new Error('too many logins in flight');
  const pty = await loadPty();
  const env = await loginEnv();
  const id = crypto.randomUUID();
  const child = pty.spawn(claudeBin(), ['mcp', 'login', name, '--no-browser'], {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: dir, env: { ...process.env, ...env },
  });
  const entry = { id, name, cwd: dir, child, buf: '', url: null, done: false, exitCode: null, startedAt: Date.now() };
  entry.timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish(entry, -1); }, LOGIN_TIMEOUT_MS);
  child.onData((d) => {
    entry.buf = (entry.buf + d).slice(-64 * 1024);
    if (!entry.url) entry.url = parseAuthUrl(entry.buf);
  });
  child.onExit(({ exitCode }) => finish(entry, exitCode));
  logins.set(id, entry);
  // Wait briefly for the URL so the first response already carries it, rather than making the page
  // poll for something that is there in well under a second.
  await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (entry.url || entry.done || Date.now() - t0 > 8000) return resolve();
      setTimeout(tick, 100);
    };
    tick();
  });
  return snapshot(entry);
}

export function loginStatus(id) {
  const entry = logins.get(String(id));
  return entry ? snapshot(entry) : null;
}

export function sendLoginInput(id, text) {
  const entry = logins.get(String(id));
  if (!entry) return null;
  if (!entry.done) entry.child.write(String(text ?? '').trim() + '\r');
  return snapshot(entry);
}

// Cancels every login in flight (process shutdown): each one holds a PTY, and a PTY keeps the
// event loop alive. Returns how many were closed.
export function cancelAllLogins() {
  let n = 0;
  for (const id of [...logins.keys()]) { if (cancelLogin(id)) n++; }
  return n;
}

export function cancelLogin(id) {
  const entry = logins.get(String(id));
  if (!entry) return null;
  try { entry.child.kill(); } catch (_) { /* already gone */ }
  finish(entry, -1);
  return snapshot(entry);
}
