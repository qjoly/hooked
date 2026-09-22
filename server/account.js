/*
 * Claude account identity (top bar avatar) and account switching.
 *
 * "Who is signed in" merges TWO sources, same reasoning as utilization.js's live/cache split:
 *   - `claude auth status --json` — live, authoritative, but costs a spawn (~150ms), so it is
 *     cached for a while: nothing here changes the account except this module's own login/logout,
 *     which invalidate the cache themselves.
 *   - `oauthAccount` in ~/.claude.json — the CLI's own cache. Carries `displayName`, which
 *     `auth status` does not expose, and is the only source once `auth status` fails (offline,
 *     binary not found).
 *
 * "Switch account" runs `claude auth login` under a real PTY, exactly like the MCP (re)auth flow
 * in mcp.js: the CLI prints the authorization URL through terminal escapes (OSC-8 hyperlink, ANSI
 * colour) and then waits on stdin for the code to be pasted back once the user has approved on the
 * login page. Reuses mcp.js's generic parsing (stripCliAnsi / parseAuthUrl / wantsPaste) — same
 * CLI, same output shape.
 *
 * Unlike `claude mcp login`, `auth login` has no `--no-browser` flag: it always tries to open a
 * browser itself. Fine for hooked's normal case (dashboard and CLI on the same machine) but under
 * remote-control it would open a browser on the HOST rather than the viewer's machine — the URL is
 * still surfaced as a link either way, so the flow completes regardless.
 *
 * This changes the ONE set of credentials the CLI keeps on disk/keychain — shared with every
 * `claude` invocation on the machine, not just hooked's driven sessions. That is the point (e.g.
 * switching to a personal subscription once the work one is rate-limited), but it means a
 * successful switch here changes what every other already-running session authenticates as too.
 */
import fs from 'node:fs';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { CLAUDE_JSON, HOME } from './config.js';
import { statSafe } from './util.js';
import { resolveClaudeBin } from './commands.js';
import { loginEnv } from './agent.js';
import { stripCliAnsi, parseAuthUrl, wantsPaste } from './mcp.js';

const STATUS_TTL_MS = 5 * 60_000;   // `auth status` state only moves via this module's own actions
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_LOGINS = 2;

// Same reason as the session/terminal/MCP-login registries: Vite re-executes server modules on
// edit in `npm run live`, and a fresh Map would orphan the PTY of a login already in flight.
const REGISTRY = Symbol.for('hooked.account.logins');
/** @type {Map<string, any>} */
const logins = globalThis[REGISTRY] || (globalThis[REGISTRY] = new Map());

// ---------- identity ----------

let fileCache = null; // { key, account }

// `oauthAccount` from ~/.claude.json, mtime+size cached (same pattern as utilization.js's
// readUtilization — cheap file, but read on every poll).
export function readAccountFile(file = CLAUDE_JSON) {
  const st = statSafe(file);
  if (!st || !st.isFile()) return null;
  const key = file + ':' + st.mtimeMs + ':' + st.size;
  if (fileCache && fileCache.key === key) return fileCache.account;
  let account = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const a = j && j.oauthAccount;
    account = a ? {
      displayName: typeof a.displayName === 'string' ? a.displayName : null,
      email: typeof a.emailAddress === 'string' ? a.emailAddress : null,
      organizationName: typeof a.organizationName === 'string' ? a.organizationName : null,
    } : null;
  } catch (_) { account = null; }
  fileCache = { key, account };
  return account;
}

function claudeBin() {
  const bin = resolveClaudeBin();
  if (!bin) throw new Error('claude binary not found');
  return bin;
}

let statusCache = null; // { at, status }

// One `claude auth status --json` call → its parsed payload, or null (binary missing, timeout,
// malformed output — never throws).
async function runAuthStatus() {
  const env = await loginEnv();
  return new Promise((resolve) => {
    let bin;
    try { bin = claudeBin(); } catch (_) { return resolve(null); }
    cp.execFile(bin, ['auth', 'status', '--json'], {
      env: { ...process.env, ...env }, timeout: 10_000, encoding: 'utf8', maxBuffer: 1 << 20,
    }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch (_) { resolve(null); }
    });
  });
}

// Merges a (possibly cached) `auth status` payload with ~/.claude.json's `oauthAccount` — pure,
// so it is testable without spawning the CLI.
export function mergeAccountInfo(status, file) {
  return {
    loggedIn: status ? !!status.loggedIn : null,
    email: (status && status.email) || (file && file.email) || null,
    displayName: (file && file.displayName) || null,
    organizationName: (status && status.orgName) || (file && file.organizationName) || null,
    subscriptionType: (status && status.subscriptionType) || null,
  };
}

// Account snapshot for the top bar. Never throws — a CLI failure just yields nulls, and the UI
// falls back to a placeholder avatar.
export async function accountInfo(now = Date.now()) {
  const file = readAccountFile();
  if (!statusCache || now - statusCache.at > STATUS_TTL_MS) {
    const status = await runAuthStatus();
    statusCache = { at: now, status };
  }
  return mergeAccountInfo(statusCache.status, file);
}

// Forces the next accountInfo() to re-spawn `auth status` — called once a login/logout completes
// so the top bar picks up the new identity immediately instead of waiting out the TTL.
function invalidateStatus() { statusCache = null; }

// ---------- switch account (PTY login / logout) ----------

let ptyMod = null;
async function loadPty() {
  if (ptyMod) return ptyMod;
  ptyMod = await import('node-pty');
  return ptyMod;
}

function snapshot(entry) {
  return {
    id: entry.id,
    url: entry.url,
    done: entry.done,
    exitCode: entry.exitCode,
    needsPaste: !entry.done && wantsPaste(entry.buf),
    output: stripCliAnsi(entry.buf).slice(-4000),
  };
}

function finish(entry, exitCode) {
  if (entry.done) return;
  entry.done = true;
  entry.exitCode = exitCode;
  clearTimeout(entry.timer);
  if (exitCode === 0) invalidateStatus();
}

// Starts `claude auth login` (or `--console` for an Anthropic Console / API-billed account) under
// a PTY. Returns once the authorization URL has appeared (or after a short grace period), so the
// first response already carries it.
export async function startAccountLogin(mode) {
  for (const [id, e] of logins) if (e.done && Date.now() - e.startedAt > 5 * 60_000) logins.delete(id);
  if (logins.size >= MAX_LOGINS) throw new Error('too many logins in flight');
  const pty = await loadPty();
  const env = await loginEnv();
  const id = crypto.randomUUID();
  const args = ['auth', 'login', ...(mode === 'console' ? ['--console'] : [])];
  const child = pty.spawn(claudeBin(), args, {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: HOME, env: { ...process.env, ...env },
  });
  const entry = { id, child, buf: '', url: null, done: false, exitCode: null, startedAt: Date.now() };
  entry.timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish(entry, -1); }, LOGIN_TIMEOUT_MS);
  child.onData((d) => {
    entry.buf = (entry.buf + d).slice(-64 * 1024);
    if (!entry.url) entry.url = parseAuthUrl(entry.buf);
  });
  child.onExit(({ exitCode }) => finish(entry, exitCode));
  logins.set(id, entry);
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

export function accountLoginStatus(id) {
  const entry = logins.get(String(id));
  return entry ? snapshot(entry) : null;
}

export function sendAccountLoginInput(id, text) {
  const entry = logins.get(String(id));
  if (!entry) return null;
  if (!entry.done) entry.child.write(String(text ?? '').trim() + '\r');
  return snapshot(entry);
}

export function cancelAccountLogin(id) {
  const entry = logins.get(String(id));
  if (!entry) return null;
  try { entry.child.kill(); } catch (_) { /* already gone */ }
  finish(entry, -1);
  return snapshot(entry);
}

// Cancels every account login in flight (process shutdown): each one holds a PTY, which keeps the
// event loop alive. Returns how many were closed.
export function cancelAllAccountLogins() {
  let n = 0;
  for (const id of [...logins.keys()]) { if (cancelAccountLogin(id)) n++; }
  return n;
}

// `claude auth logout` — plain execFile, no PTY needed (no browser, no stdin wait).
export async function accountLogout() {
  const env = await loginEnv();
  const bin = claudeBin();
  return new Promise((resolve) => {
    cp.execFile(bin, ['auth', 'logout'], {
      env: { ...process.env, ...env }, timeout: 15_000, encoding: 'utf8', maxBuffer: 1 << 20,
    }, (err, stdout, stderr) => {
      invalidateStatus();
      resolve({ ok: !err, message: stripCliAnsi(String(stdout || '') + String(stderr || '')).trim() });
    });
  });
}
