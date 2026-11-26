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
 *
 * A profile with its own account (`configDir`, cf. server/profiles.js) is the exception: every
 * function here takes an optional profile id and then works on THAT account's directory, through
 * its own CLAUDE_CONFIG_DIR. Signing it in or out touches nothing else on the machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { CLAUDE_JSON, HOME } from './config.js';
import { DEFAULT_PROFILE_ID, findProfile, buildSessionEnv } from './profiles.js';
import { prepareAccountDir } from './accountDir.js';
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

const fileCache = new Map(); // file -> { key, account }, one entry per account

// `oauthAccount` from ~/.claude.json, mtime+size cached (same pattern as utilization.js's
// readUtilization — cheap file, but read on every poll).
export function readAccountFile(file = CLAUDE_JSON) {
  const st = statSafe(file);
  if (!st || !st.isFile()) return null;
  const key = st.mtimeMs + ':' + st.size;
  const hit = fileCache.get(file);
  if (hit && hit.key === key) return hit.account;
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
  fileCache.set(file, { key, account });
  return account;
}

function claudeBin() {
  const bin = resolveClaudeBin();
  if (!bin) throw new Error('claude binary not found');
  return bin;
}

const statusCache = new Map(); // account key -> { at, status }

// What an account operation needs to know about the account it is for: the environment to run the
// CLI with, the file its identity is cached in, and the key its caches go under. Pure, so the
// part that decides is testable without spawning anything. The default account is the login
// environment as it is. A profile's account gets its own CLAUDE_CONFIG_DIR, and loses the
// credential variables of the login environment (buildSessionEnv): `auth status` and `auth login`
// must talk about that account, not about whatever the shell happens to export.
export function accountScope(profile, base) {
  if (!profile) return { key: 'default', env: { ...process.env, ...base }, file: CLAUDE_JSON, profile: null };
  if (!profile.configDir) throw new Error('this profile has no account of its own');
  return {
    key: profile.id,
    env: { ...process.env, ...buildSessionEnv(base, profile, {}) },
    file: path.join(profile.configDir, '.claude.json'),
    profile,
  };
}

async function accountContext(profileId) {
  const base = await loginEnv();
  if (!profileId || profileId === DEFAULT_PROFILE_ID) return accountScope(null, base);
  const profile = findProfile(profileId);
  if (!profile) throw new Error('unknown profile');
  return accountScope(profile, base);
}

// One `claude auth status --json` call → its parsed payload, or null (binary missing, timeout,
// malformed output — never throws).
async function runAuthStatus(scope) {
  const env = scope.env;
  return new Promise((resolve) => {
    let bin;
    try { bin = claudeBin(); } catch (_) { return resolve(null); }
    cp.execFile(bin, ['auth', 'status', '--json'], {
      env, timeout: 10_000, encoding: 'utf8', maxBuffer: 1 << 20,
    }, (_err, stdout) => resolve(parseAuthStatus(stdout)));
  });
}

// `claude auth status --json` exits with 1 when nobody is signed in, and still prints its answer:
// reading the exit code instead of the output turned "signed out" into "unknown". So the output is
// what counts, whatever the exit code; anything that is not a status object (a timeout, a crash,
// partial output) is null. Pure.
export function parseAuthStatus(stdout) {
  try {
    const j = JSON.parse(stdout);
    return j && typeof j === 'object' && typeof j.loggedIn === 'boolean' ? j : null;
  } catch (_) { return null; }
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
// `profileId` (default: the default account) picks whose identity it is. An unknown profile, or one
// with no account of its own, is an error: that is a caller's mistake, not a CLI failure.
export async function accountInfo(profileId = null, now = Date.now()) {
  const scope = await accountContext(profileId);
  // An account whose directory does not exist yet has never been signed in: say so without running
  // the CLI, which would create the directory (with the default permissions) just by looking.
  if (scope.profile && !statSafe(scope.profile.configDir)) return mergeAccountInfo({ loggedIn: false }, null);
  const file = readAccountFile(scope.file);
  const cached = statusCache.get(scope.key);
  if (!cached || now - cached.at > STATUS_TTL_MS) {
    statusCache.set(scope.key, { at: now, status: await runAuthStatus(scope) });
  }
  return mergeAccountInfo(statusCache.get(scope.key).status, file);
}

// Forces the next accountInfo() of that account to re-spawn `auth status` — called once a
// login/logout completes so the new identity shows at once instead of after the TTL.
function invalidateStatus(key = 'default') { statusCache.delete(key); }

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
    profile: entry.profile,
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
  if (exitCode === 0) invalidateStatus(entry.key);
}

// How many logins still hold a PTY. A finished one stays in the registry for a few minutes so its
// result can still be polled, but it must not count against the limit: with several accounts, two
// quick sign-ins (or cancels) would otherwise lock out every other one for five minutes.
export function countLoginsInFlight(registry) {
  let n = 0;
  for (const e of registry.values()) if (!e.done) n++;
  return n;
}

// Ends the logins still open for one account (`key`: 'default' or a profile id). A sign-in the user
// walked away from keeps its PTY, and the limit above, until it times out ten minutes later: so a
// new sign-in for the same account takes the place of the old one instead of queueing behind it, and
// removing an account ends whatever is open for it. Returns how many were ended.
export function cancelLoginsOf(registry, key) {
  let n = 0;
  for (const e of registry.values()) {
    if (e.done || e.key !== key) continue;
    try { e.child.kill(); } catch (_) { /* already gone */ }
    finish(e, -1);
    n++;
  }
  return n;
}

export function cancelAccountLoginsFor(profileId = null) {
  return cancelLoginsOf(logins, profileId && profileId !== DEFAULT_PROFILE_ID ? profileId : 'default');
}

// Starts `claude auth login` (or `--console` for an Anthropic Console / API-billed account) under
// a PTY. Returns once the authorization URL has appeared (or after a short grace period), so the
// first response already carries it.
export async function startAccountLogin(mode, profileId = null) {
  for (const [id, e] of logins) if (e.done && Date.now() - e.startedAt > 5 * 60_000) logins.delete(id);
  const pty = await loadPty();
  const scope = await accountContext(profileId);
  cancelLoginsOf(logins, scope.key);
  if (countLoginsInFlight(logins) >= MAX_LOGINS) throw new Error('Too many sign-ins are open at once. Finish or cancel one first.');
  // A profile's account dir has to exist, with the shared parts linked in, before anything is
  // signed into it: sessions on it then find their hooks and write their transcripts where hooked
  // reads them.
  if (scope.profile) {
    const prep = prepareAccountDir(scope.profile);
    if (prep.error) throw new Error(prep.error);
  }
  const id = crypto.randomUUID();
  const args = ['auth', 'login', ...(mode === 'console' ? ['--console'] : [])];
  const child = pty.spawn(claudeBin(), args, {
    name: 'xterm-256color', cols: 120, rows: 40, cwd: HOME, env: scope.env,
  });
  const entry = { id, child, buf: '', url: null, done: false, exitCode: null, startedAt: Date.now(), key: scope.key, profile: scope.profile ? scope.profile.id : null };
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
export async function accountLogout(profileId = null) {
  const scope = await accountContext(profileId);
  const bin = claudeBin();
  return new Promise((resolve) => {
    cp.execFile(bin, ['auth', 'logout'], {
      env: scope.env, timeout: 15_000, encoding: 'utf8', maxBuffer: 1 << 20,
    }, (err, stdout, stderr) => {
      invalidateStatus(scope.key);
      resolve({ ok: !err, message: stripCliAnsi(String(stdout || '') + String(stderr || '')).trim() });
    });
  });
}
