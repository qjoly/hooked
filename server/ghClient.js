import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { loginEnv } from './agent.js';

// Design after T3 Code (MIT, pingdotgg/t3code): GitHubRequestPolicy.ts, GitHubQuota.ts,
// GitHubCredentials.ts and SourceControlRateLimit.ts.

const API = 'https://api.github.com';
// GitHub's secondary rate limit penalizes concurrent bursts.
const CONCURRENCY = 8;
const TIMEOUT_MS = 30_000;
const TOKEN_TTL_MS = 5 * 60_000;
// Background reads stop at this share of the quota, so interactive calls keep the rest.
const RESERVE_RATIO = 0.1;
const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const ETAG_CAPACITY = 300;
const REDIRECTS = [301, 302, 303, 307, 308];
const HEADERS = { 'x-github-api-version': '2022-11-28', 'user-agent': 'hooked' };

const STATE = Symbol.for('hooked.gh.client');
function state() {
  globalThis[STATE] ??= {
    token: null, active: 0, queue: [], quota: new Map(), pause: { until: 0, attempt: 0 }, etags: new Map(),
  };
  return globalThis[STATE];
}

export class GhError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

let ghBinPromise = null;
export function resolveGh() {
  if (ghBinPromise) return ghBinPromise;
  ghBinPromise = new Promise((resolve) => {
    const home = process.env.HOME || '';
    const candidates = [
      '/home/linuxbrew/.linuxbrew/bin/gh', '/opt/homebrew/bin/gh',
      '/usr/local/bin/gh', '/usr/bin/gh', `${home}/.local/bin/gh`,
    ];
    for (const p of candidates) { try { if (fs.existsSync(p)) return resolve(p); } catch { /* ignore */ } }
    const shell = process.env.SHELL || '/bin/sh';
    execFile(shell, ['-l', '-c', 'command -v gh'], { timeout: 4000 }, (err, out) => {
      const p = String(out || '').trim().split('\n').filter(Boolean).pop();
      resolve(err || !p ? 'gh' : p);
    });
  });
  return ghBinPromise;
}

async function readToken() {
  const env = await loginEnv();
  const fromEnv = String(env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const bin = await resolveGh();
  return new Promise((resolve, reject) => {
    // GH_DEBUG would print the token into gh's debug output.
    execFile(bin, ['auth', 'token', '--hostname', 'github.com'],
      { env: { ...env, GH_DEBUG: '', GH_PROMPT_DISABLED: '1' }, timeout: 10_000 }, (err, stdout) => {
        const token = String(stdout || '').trim();
        if (err?.code === 'ENOENT') {
          return reject(new GhError('no_credential', 'No GitHub credential: set GITHUB_TOKEN, or install the GitHub CLI and run `gh auth login`.'));
        }
        if (err || !token) return reject(new GhError('no_credential', 'Not signed in to GitHub: run `gh auth login`.'));
        resolve(token);
      });
  });
}

function token() {
  const s = state();
  if (s.token && Date.now() - s.token.at < TOKEN_TTL_MS) return s.token.promise;
  const promise = readToken();
  s.token = { at: Date.now(), promise };
  promise.catch(() => { if (s.token?.promise === promise) s.token = null; });
  return promise;
}

const fingerprint = (tok) => crypto.createHash('sha256').update(tok).digest('hex').slice(0, 16);

async function withSlot(fn) {
  const s = state();
  if (s.active < CONCURRENCY) s.active++;
  else await new Promise((resolve) => s.queue.push(resolve));
  try {
    return await fn();
  } finally {
    const next = s.queue.shift();
    if (next) next();
    else s.active--;
  }
}

export function quotaFromHeaders(headers) {
  const resource = String(headers['x-ratelimit-resource'] || '').trim();
  const limit = Number(headers['x-ratelimit-limit']);
  const remaining = Number(headers['x-ratelimit-remaining']);
  const reset = Number(headers['x-ratelimit-reset']);
  if (!resource || !(limit > 0) || !(remaining >= 0) || !Number.isFinite(reset)) return null;
  return { resource, limit, remaining, resetAt: reset * 1000 };
}

export function retryAtFrom(headers, now) {
  const after = String(headers['retry-after'] ?? '').trim();
  if (/^\d+$/.test(after)) return now + Number(after) * 1000;
  if (after) {
    const at = Date.parse(after);
    if (at > now) return at;
  }
  const reset = Number(headers['x-ratelimit-reset']) * 1000;
  return reset > now ? reset : undefined;
}

export const cooldownMs = (attempt) => Math.min(BASE_COOLDOWN_MS * 2 ** Math.max(0, attempt - 1), MAX_COOLDOWN_MS);

const namesLimit = (text) => typeof text === 'string' && /rate limit|abuse detection mechanism/i.test(text);

// A GraphQL rate limit comes back as HTTP 200. A 403 is a limit only when its quota, body or
// errors name one: a proxy can refuse with Retry-After alone.
export function isRateLimited({ status, headers, graphqlErrors, body }) {
  if (status === 429) return true;
  if (graphqlErrors && (headers['x-ratelimit-remaining'] === '0'
    || graphqlErrors.some((e) => e?.type === 'RATE_LIMITED' || /rate limit (already )?exceeded/i.test(e?.message || '')))) return true;
  return status === 403 && (headers['x-ratelimit-remaining'] === '0' || namesLimit(body)
    || (graphqlErrors || []).some((e) => namesLimit(e?.message)));
}

function pausedError(until) {
  return new GhError('rate_limited', `GitHub rate limit reached, retrying after ${new Date(until).toLocaleTimeString()}.`, { retryAt: until });
}

function admit(resource, background) {
  const s = state();
  const now = Date.now();
  if (background && s.pause.until > now) throw pausedError(s.pause.until);
  const q = s.quota.get(resource);
  if (!q || q.resetAt <= now) return;
  if (q.remaining < (background ? q.limit * RESERVE_RATIO : 1)) throw pausedError(q.resetAt);
}

function observe(headers) {
  const q = quotaFromHeaders(headers);
  if (!q) return;
  const quota = state().quota;
  const prev = quota.get(q.resource);
  if (prev && q.resetAt < prev.resetAt) return;
  quota.set(q.resource, q);
}

function recordSuccess() {
  const { pause } = state();
  if (pause.until <= Date.now()) pause.attempt = 0;
}

function recordRateLimit(retryAt) {
  const { pause } = state();
  const now = Date.now();
  pause.attempt += 1;
  pause.until = Math.max(pause.until, retryAt > now ? retryAt : now + cooldownMs(pause.attempt));
  return pause.until;
}

function bodyMessage(body) {
  try { return JSON.parse(body)?.message || ''; } catch { return String(body || '').slice(0, 200); }
}

function failure(status, headers, body, graphqlErrors) {
  if (isRateLimited({ status, headers, body, graphqlErrors })) return pausedError(recordRateLimit(retryAtFrom(headers, Date.now())));
  if (status === 401) {
    state().token = null;
    return new GhError('auth', 'GitHub refused the credential: run `gh auth login` and retry.', { status });
  }
  if (status === 404) return new GhError('not_found', 'GitHub could not find this, or the credential cannot see it.', { status });
  const messages = graphqlErrors?.length ? graphqlErrors.map((e) => e.message) : [bodyMessage(body)].filter(Boolean);
  return new GhError('http', messages.length ? `GitHub returned an error: ${messages.join('; ')}` : `GitHub returned HTTP ${status}.`, { status });
}

async function send(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError';
    throw new GhError('network', timedOut ? 'GitHub did not answer in time.' : `Could not reach GitHub: ${e?.cause?.message || e?.message || e}`);
  }
}

// A cross-origin redirect (job logs live on blob storage) must not carry the token along.
async function fetchFollowing(url, init) {
  let current = new URL(url);
  let headers = init.headers;
  for (let hop = 0; hop < 5; hop++) {
    const res = await send(current, { ...init, headers, redirect: 'manual' });
    if (current.origin === API) observe(Object.fromEntries(res.headers));
    const location = res.headers.get('location');
    if (!REDIRECTS.includes(res.status) || !location || init.method !== 'GET') return res;
    await res.body?.cancel();
    const next = new URL(location, current);
    if (next.origin !== current.origin) {
      const { authorization, ...rest } = headers;
      headers = rest;
    }
    current = next;
  }
  throw new GhError('http', 'Too many redirects from GitHub.');
}

function rememberEtag(key, etag, value) {
  const { etags } = state();
  etags.delete(key);
  etags.set(key, { etag, value });
  if (etags.size > ETAG_CAPACITY) etags.delete(etags.keys().next().value);
}

/**
 * REST call. `etag` revalidates a cached answer: a 304 costs no quota. `background` marks a read
 * nobody is waiting on, which yields to rate-limit pauses and leaves the quota reserve alone.
 */
export function ghRest(path, { method = 'GET', accept = 'application/vnd.github+json', raw = false, etag = false, background = false, timeout = TIMEOUT_MS } = {}) {
  const url = `${API}/${String(path).replace(/^\//, '')}`;
  return withSlot(async () => {
    admit('core', background);
    const tok = await token();
    const key = etag && method === 'GET' ? `${fingerprint(tok)} ${accept} ${url}` : null;
    const cached = key ? state().etags.get(key) : null;
    const res = await fetchFollowing(url, {
      method,
      headers: { ...HEADERS, accept, authorization: `Bearer ${tok}`, ...(cached ? { 'if-none-match': cached.etag } : {}) },
      signal: AbortSignal.timeout(timeout),
    });
    const headers = Object.fromEntries(res.headers);
    if (res.status === 304 && cached) {
      recordSuccess();
      rememberEtag(key, cached.etag, cached.value);
      return cached.value;
    }
    const text = await res.text();
    if (!res.ok) throw failure(res.status, headers, text);
    recordSuccess();
    const value = raw ? text : (text ? JSON.parse(text) : null);
    if (key && headers.etag) rememberEtag(key, headers.etag, value);
    return value;
  });
}

/**
 * GraphQL call, returns `data`. A missing node is an error unless `partial` is set: aliased
 * batches then get `null` for that alias and keep the rest.
 */
export function ghGraphql(query, variables = {}, { background = false, partial = false, timeout = TIMEOUT_MS } = {}) {
  return withSlot(async () => {
    admit('graphql', background);
    const tok = await token();
    const res = await send(`${API}/graphql`, {
      method: 'POST',
      headers: { ...HEADERS, accept: 'application/vnd.github+json', 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeout),
    });
    const headers = Object.fromEntries(res.headers);
    observe(headers);
    const text = await res.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* reported below */ }
    const errors = Array.isArray(payload?.errors) && payload.errors.length ? payload.errors : undefined;
    if (!res.ok || isRateLimited({ status: res.status, headers, graphqlErrors: errors, body: text })) {
      throw failure(res.status, headers, text, errors);
    }
    if (!payload?.data || (errors && !partial)) {
      if (errors?.every((e) => e.type === 'NOT_FOUND')) throw new GhError('not_found', errors[0].message, { status: 200 });
      throw failure(res.status, headers, text, errors || [{ message: 'GitHub sent no data' }]);
    }
    recordSuccess();
    return payload.data;
  });
}

const ITEM_URL = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)(?:[/?#]|$)/;

export function parseItemUrl(url) {
  const m = ITEM_URL.exec(String(url || ''));
  return m ? { owner: m[1], name: m[2], kind: m[3] === 'pull' ? 'pr' : 'issue', number: Number(m[4]) } : null;
}

export function parseGithubRemote(remote) {
  const m = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(remote || '').trim());
  return m ? { owner: m[1], name: m[2] } : null;
}
