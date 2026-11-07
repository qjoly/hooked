// Token required for any request that does not come from this machine (phone, LAN, WireGuard).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOOKED_DIR } from './config.js';

const TOKEN_FILE = path.join(HOOKED_DIR, 'remote-token');
const COOKIE = 'hooked_token';
const cache = (globalThis[Symbol.for('hooked.remoteToken')] ||= { token: null });

function remoteToken() {
  if (cache.token) return cache.token;
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return (cache.token = t);
  } catch (_) { }
  return rotateRemoteToken();
}

function rotateRemoteToken() {
  const t = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(HOOKED_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  return (cache.token = t);
}

function isLoopbackAddress(addr) {
  const a = String(addr || '').replace(/^::ffff:/i, '');
  return a === '::1' || /^127\./.test(a);
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

const cookieValue = (header, name) => {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};

// 'ok' | 'pair' (valid ?token= from a browser: set the cookie, then redirect) | 'deny'.
function authorizeRemote({ addr, authorization, cookie, queryToken }, token = remoteToken()) {
  if (isLoopbackAddress(addr)) return 'ok';
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization || '')?.[1];
  if (sameToken(bearer, token) || sameToken(cookieValue(cookie, COOKIE), token)) return 'ok';
  if (sameToken(queryToken, token)) return 'pair';
  return 'deny';
}

const remoteCookie = (token = remoteToken()) =>
  `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;

export { remoteToken, rotateRemoteToken, isLoopbackAddress, authorizeRemote, remoteCookie };
