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
 *   3. macOS Keychain, generic password under the service "Claude Code-credentials" -- for a config
 *      dir other than ~/.claude, that name plus "-<first 8 hex of sha256(the dir's path)>" (see
 *      keychainServiceFor): each account that has its own CLAUDE_CONFIG_DIR has its own item.
 *
 * `accessToken(now, configDir)` reads the token of the account living in that dir; no dir means the
 * default account. Every account has its own cache: two accounts never see each other's token.
 *
 * The token NEVER leaves this module's return value: no logging, no error message carrying it.
 * Node stdlib only.
 */
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { HOME } from './config.js';
import { normalizeConfigDir } from './profiles.js';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CREDENTIALS_FILE = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), '.credentials.json');
// Spawning `security` costs ~30 ms and can be audited by the OS: we re-read at most once a minute,
// which is far more often than the token rotates (hours).
const REREAD_MS = 60_000;

const cache = new Map(); // account key -> { token, expiresAtMs, readAtMs }

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

// The Keychain item of the account whose config dir is `configDir`. The CLI names it after a hash
// of the dir's path -- the first 8 hex characters of sha256 of the absolute path, no trailing slash
// -- except for ~/.claude itself, which keeps the bare name. Checked on a real install: the items
// of two dirs matched the hashes computed this way.
export function keychainServiceFor(configDir, home = HOME) {
  const dir = normalizeConfigDir(configDir, home);
  if (!dir || dir === normalizeConfigDir(path.join(home, '.claude'), home)) return KEYCHAIN_SERVICE;
  return KEYCHAIN_SERVICE + '-' + crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8);
}

function fromKeychain(services) {
  if (process.platform !== 'darwin') return null;
  for (const service of services) {
    try {
      // execFileSync (no shell) → the service name is an argument, never interpolated in a command.
      const out = cp.execFileSync('security', ['find-generic-password', '-s', service, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      const found = parseCredentials(out);
      if (found) return found;
    } catch (_) { /* not found, locked keychain, denied access: try the next name */ }
  }
  return null;
}

// Current access token, or null when there is none we can use (absent, malformed, expired).
// Cached for REREAD_MS, and dropped early once we cross the token's own expiry.
function accessToken(now = Date.now(), configDir = null) {
  // The override is for the default account only: it must not stand in for another account's token.
  if (!configDir && process.env.HOOKED_OAUTH_TOKEN) return process.env.HOOKED_OAUTH_TOKEN;
  const key = configDir || 'default';
  const hit = cache.get(key);
  const fresh = hit && now - hit.readAtMs < REREAD_MS && !(hit.expiresAtMs && hit.expiresAtMs <= now);
  if (fresh) return hit.token;
  const found = configDir
    ? (fromFile(path.join(configDir, '.credentials.json')) || fromKeychain([keychainServiceFor(configDir)]))
    // The default account: its dir is CLAUDE_CONFIG_DIR when hooked runs with one, and the bare
    // Keychain name stays as a fallback, as it always was.
    : (fromFile() || fromKeychain([...new Set([keychainServiceFor(path.dirname(CREDENTIALS_FILE)), KEYCHAIN_SERVICE])]));
  if (!found) { cache.delete(key); return null; }
  cache.set(key, { ...found, readAtMs: now });
  if (found.expiresAtMs && found.expiresAtMs <= now) return null; // stale: the CLI will refresh it
  return found.token;
}

export { accessToken, parseCredentials, CREDENTIALS_FILE, KEYCHAIN_SERVICE };
