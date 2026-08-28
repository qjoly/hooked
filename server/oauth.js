/*
 * Read-only access to Claude Code's own OAuth access token, so hooked can query the account
 * usage endpoint directly (cf. server/utilization.js).
 *
 * We never mint, refresh or persist anything: we read the token the CLI already stored, and give
 * up when it is absent or expired (the CLI refreshes it on its next API call). Storage, in the
 * order the CLI itself uses:
 *   1. HOOKED_OAUTH_TOKEN            → explicit override (tests, headless setups);
 *   2. <CLAUDE_CONFIG_DIR|~/.claude>/.credentials.json → plain file (Linux, and macOS when the
 *      user opted out of the Keychain);
 *   3. macOS Keychain, generic password under the service "Claude Code-credentials".
 *
 * The token NEVER leaves this module's return value: no logging, no error message carrying it.
 * Node stdlib only.
 */
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { HOME } from './config.js';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CREDENTIALS_FILE = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), '.credentials.json');
// Spawning `security` costs ~30 ms and can be audited by the OS: we re-read at most once a minute,
// which is far more often than the token rotates (hours).
const REREAD_MS = 60_000;

let cache = null; // { token, expiresAtMs, readAtMs }

// `{ claudeAiOauth: { accessToken, expiresAt } }` → { token, expiresAtMs }, or null on any
// malformed / missing shape. `expiresAt` is an epoch in ms.
function parseCredentials(raw) {
  try {
    const o = JSON.parse(raw);
    const c = o && o.claudeAiOauth;
    const token = c && typeof c.accessToken === 'string' ? c.accessToken : null;
    if (!token) return null;
    const exp = Number(c.expiresAt);
    return { token, expiresAtMs: Number.isFinite(exp) ? exp : null };
  } catch (_) { return null; }
}

function fromFile(file = CREDENTIALS_FILE) {
  try { return parseCredentials(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function fromKeychain() {
  if (process.platform !== 'darwin') return null;
  try {
    // execFileSync (no shell) → the service name is an argument, never interpolated in a command.
    const out = cp.execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return parseCredentials(out);
  } catch (_) { return null; }  // not found, locked keychain, denied access → no token
}

// Current access token, or null when there is none we can use (absent, malformed, expired).
// Cached for REREAD_MS, and dropped early once we cross the token's own expiry.
function accessToken(now = Date.now()) {
  if (process.env.HOOKED_OAUTH_TOKEN) return process.env.HOOKED_OAUTH_TOKEN;
  const fresh = cache && now - cache.readAtMs < REREAD_MS
    && !(cache.expiresAtMs && cache.expiresAtMs <= now);
  if (fresh) return cache.token;
  const found = fromFile() || fromKeychain();
  if (!found) { cache = null; return null; }
  cache = { ...found, readAtMs: now };
  if (found.expiresAtMs && found.expiresAtMs <= now) return null; // stale: the CLI will refresh it
  return found.token;
}

export { accessToken, parseCredentials, CREDENTIALS_FILE, KEYCHAIN_SERVICE };
