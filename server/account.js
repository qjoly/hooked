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
 * successful switch here changes what every other already-running session authenticates as too —
 * including any OTHER driven session that happens to be mid-turn right now. `accountInfo()` folds
 * in `liveBusyCount()` so the UI can warn before a switch stomps on a running turn.
 *
 * The roster below (`listRosterAccounts` / `save` / `switchToRosterAccount` / `remove` / `rename`)
 * is the opt-in layer that avoids repeating the full `claude auth login` dance for an account
 * that's already been signed into once: hooked keeps a second copy of that account's credentials
 * itself and just writes them back over the active slot. See its own comment below for the
 * storage tradeoff — it is NOT the same trust model as the single CLI-managed slot above.
 */
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { CLAUDE_JSON, HOME, HOOKED_DIR } from './config.js';
import { statSafe } from './util.js';
import { resolveClaudeBin } from './commands.js';
import { loginEnv, liveBusyCount } from './agent.js';
import { stripCliAnsi, parseAuthUrl, wantsPaste } from './mcp.js';
import { CREDENTIALS_FILE, KEYCHAIN_SERVICE } from './oauth.js';

const STATUS_TTL_MS = 5 * 60_000;   // `auth status` state only moves via this module's own actions
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_LOGINS = 2;

export { LOGIN_TIMEOUT_MS };

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
  // busySessions: how many driven sessions are mid-turn right now — a switch below would yank
  // credentials out from under them. Pure in-memory read, no extra cost on every poll.
  return { ...mergeAccountInfo(statusCache.status, file), busySessions: liveBusyCount() };
}

// Forces the next accountInfo() to re-spawn `auth status` — called once a login/logout completes
// so the top bar picks up the new identity immediately instead of waiting out the TTL, and
// exposed to the route so the client can force a fresh read (e.g. tab regains focus) instead of
// trusting the blind 5-minute TTL when it actually matters.
export function invalidateStatus() { statusCache = null; }

// ---------- switch account (PTY login / logout) ----------

let ptyMod = null;
async function loadPty() {
  if (ptyMod) return ptyMod;
  ptyMod = await import('node-pty');
  return ptyMod;
}

// Exported for the tests: both are pure given a fake `entry` object — no real PTY/child needed.
export function snapshot(entry) {
  return {
    id: entry.id,
    url: entry.url,
    done: entry.done,
    exitCode: entry.exitCode,
    // null while running; once done, one of 'timeout' | 'cancelled' | 'exited' | null (exitCode 0).
    // Distinguishes a login that expired from one the user backed out of — both land on exitCode
    // -1, so the UI needs this to show the right message instead of a generic "ended".
    reason: entry.reason || null,
    startedAt: entry.startedAt,
    timeoutMs: LOGIN_TIMEOUT_MS, // so the UI can show/explain the deadline without hardcoding it
    needsPaste: !entry.done && wantsPaste(entry.buf),
    output: stripCliAnsi(entry.buf).slice(-4000),
  };
}

export function finish(entry, exitCode, reason = null) {
  if (entry.done) return;
  entry.done = true;
  entry.exitCode = exitCode;
  entry.reason = exitCode === 0 ? null : reason;
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
  const entry = { id, child, buf: '', url: null, done: false, exitCode: null, reason: null, startedAt: Date.now() };
  entry.timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish(entry, -1, 'timeout'); }, LOGIN_TIMEOUT_MS);
  child.onData((d) => {
    entry.buf = (entry.buf + d).slice(-64 * 1024);
    if (!entry.url) entry.url = parseAuthUrl(entry.buf);
  });
  child.onExit(({ exitCode }) => finish(entry, exitCode, 'exited'));
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
  finish(entry, -1, 'cancelled');
  return snapshot(entry);
}

// Cancels every account login in flight (process shutdown): each one holds a PTY, which keeps the
// event loop alive. Returns how many were closed.
export function cancelAllAccountLogins() {
  let n = 0;
  for (const id of [...logins.keys()]) { if (cancelAccountLogin(id)) n++; }
  return n;
}

// ---------- roster (save an account, switch back without a fresh login) ----------
//
// The flow above always re-authenticates. This is the opt-in layer on top: once signed in,
// "save this account" lets a later switch skip the OAuth dance entirely — just write the same
// credentials back over the active slot. That means hooked now holds a SECOND copy of the OAuth
// secret, so storage follows the platform's own posture rather than inventing a new one:
//   - macOS: a separate Keychain item per saved account (service `hooked-account:<id>`) — the
//     same OS-level protection the CLI itself uses for the active slot.
//   - everywhere else (and macOS with the Keychain unavailable): one file per account under
//     HOOKED_DIR/account-secrets, chmod 0600 — no regression from the CLI's own posture, which
//     already keeps the active slot as a plain file (CREDENTIALS_FILE) there.
// The roster's own index (accounts.json) never carries a secret, only display metadata: listing
// saved accounts never touches the keychain or a secrets file.
const ROSTER_FILE = path.join(HOOKED_DIR, 'accounts.json');
const SECRETS_DIR = path.join(HOOKED_DIR, 'account-secrets');
const HOOKED_KEYCHAIN_PREFIX = 'hooked-account:';
const MAX_ROSTER = 12; // soft cap — mirrors MAX_LOGINS's reasoning, just for a slower-moving list

// Exported for the tests: every one of these takes its file/dir/platform as an injectable
// argument specifically so the pure read/write/merge logic can be exercised against a tmpdir
// instead of the real ~/.claude/hooked — same idiom as readAccountFile(file) above.
export function readRoster(file = ROSTER_FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j && j.accounts) ? j.accounts : [];
  } catch (_) { return []; }
}

export function writeRoster(accounts, file = ROSTER_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ accounts }, null, 2));
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

// Pure — exported for the tests: stamps each roster entry with whether IT is the one currently
// signed in, keyed on email so there is no separate "which id is active" state to keep in sync.
export function markRosterActive(roster, currentEmail) {
  return roster.map((a) => ({ ...a, active: !!(currentEmail && a.email === currentEmail) }));
}

// Roster entries for the UI: metadata only (no secrets read, no keychain/CLI spawn beyond the
// identity check already paid for elsewhere).
export async function listRosterAccounts() {
  const info = await accountInfo();
  return markRosterActive(readRoster(), info.email);
}

// Raw credentials blob currently in force, wherever the CLI keeps it — same file-then-keychain
// order oauth.js reads in (server/oauth.js), but the untouched text rather than the parsed token:
// this has to be written back byte for byte later.
export function readActiveCredentialsRaw(file = CREDENTIALS_FILE, platform = process.platform) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw && raw.trim()) return raw;
  } catch (_) { /* fall through to keychain */ }
  if (platform === 'darwin') {
    try {
      const raw = cp.execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      if (raw && raw.trim()) return raw;
    } catch (_) { /* neither source has anything usable */ }
  }
  return null;
}

// Writes a saved account's credentials back over whichever slot the CLI is CURRENTLY reading
// from (file if CREDENTIALS_FILE already exists, keychain otherwise) — so hooked never creates a
// second, unread copy the CLI ignores.
export function writeActiveCredentialsRaw(raw, file = CREDENTIALS_FILE, platform = process.platform) {
  if (fs.existsSync(file) || platform !== 'darwin') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw);
    try { fs.chmodSync(file, 0o600); } catch (_) {}
    return;
  }
  cp.execFileSync('security', ['add-generic-password', '-a', KEYCHAIN_SERVICE, '-s', KEYCHAIN_SERVICE, '-w', raw, '-U'],
    { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 });
}

export function writeSecret(id, raw, dir = SECRETS_DIR, platform = process.platform) {
  if (platform === 'darwin') {
    cp.execFileSync('security', ['add-generic-password', '-a', id, '-s', HOOKED_KEYCHAIN_PREFIX + id, '-w', raw, '-U'],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 });
    return 'keychain';
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.json');
  fs.writeFileSync(file, raw);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  return 'file';
}

export function readSecret(id, platform, dir = SECRETS_DIR) {
  if (platform === 'keychain') {
    try {
      return cp.execFileSync('security', ['find-generic-password', '-s', HOOKED_KEYCHAIN_PREFIX + id, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    } catch (_) { return null; }
  }
  try { return fs.readFileSync(path.join(dir, id + '.json'), 'utf8'); } catch (_) { return null; }
}

export function deleteSecret(id, platform, dir = SECRETS_DIR) {
  if (platform === 'keychain') {
    try {
      cp.execFileSync('security', ['delete-generic-password', '-s', HOOKED_KEYCHAIN_PREFIX + id],
        { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 });
    } catch (_) { /* already gone */ }
    return;
  }
  try { fs.unlinkSync(path.join(dir, id + '.json')); } catch (_) {}
}

// Saves the CURRENTLY signed-in account into the roster under `label`, so switching back later
// skips the OAuth dance. Replaces any existing roster entry for the same email (one slot per
// account — an older saved copy would only ever be stale) and trims to MAX_ROSTER, oldest first.
export async function saveCurrentAccountToRoster(label) {
  const raw = readActiveCredentialsRaw();
  if (!raw) throw new Error('no active account to save');
  const info = await accountInfo();
  const id = crypto.randomUUID();
  const platform = writeSecret(id, raw);
  const entry = {
    id,
    label: (label && String(label).trim()) || info.displayName || info.email || 'Account',
    email: info.email || null,
    displayName: info.displayName || null,
    organizationName: info.organizationName || null,
    savedAt: new Date().toISOString(),
    platform,
  };
  const roster = readRoster();
  const dupes = entry.email ? roster.filter((a) => a.email === entry.email) : [];
  for (const d of dupes) deleteSecret(d.id, d.platform);
  const dupeIds = new Set(dupes.map((d) => d.id));
  const kept = roster.filter((a) => !dupeIds.has(a.id));
  kept.push(entry);
  kept.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1)); // newest first
  const evicted = kept.slice(MAX_ROSTER);
  for (const e of evicted) deleteSecret(e.id, e.platform);
  writeRoster(kept.slice(0, MAX_ROSTER));
  return entry;
}

// Switches the ACTIVE credentials to a saved roster account — no browser, no PTY, just a write
// plus the same cache invalidation a login/logout gets.
export async function switchToRosterAccount(id) {
  const entry = readRoster().find((a) => a.id === id);
  if (!entry) throw new Error('unknown saved account');
  const raw = readSecret(entry.id, entry.platform);
  if (!raw) throw new Error('saved credentials are gone — remove and re-save this account');
  writeActiveCredentialsRaw(raw);
  invalidateStatus();
  return accountInfo();
}

export function removeRosterAccount(id) {
  const roster = readRoster();
  const entry = roster.find((a) => a.id === id);
  if (!entry) return false;
  deleteSecret(entry.id, entry.platform);
  writeRoster(roster.filter((a) => a.id !== id));
  return true;
}

export function renameRosterAccount(id, label) {
  const roster = readRoster();
  const entry = roster.find((a) => a.id === id);
  if (!entry) return null;
  entry.label = (label && String(label).trim()) || entry.label;
  writeRoster(roster);
  return entry;
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
