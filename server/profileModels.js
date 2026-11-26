/*
 * The models a `compatible` profile's server offers, read from its `/v1/models`: what the pickers
 * list for a profile that does not name its models itself. A profile that does is used as written,
 * and never asks the server.
 *
 * Both flavours of the endpoint answer `{ data: [{ id, … }] }`. The request goes to the profile's
 * own `ANTHROPIC_BASE_URL`, carrying its own credential (`ANTHROPIC_AUTH_TOKEN` as a bearer token,
 * else `ANTHROPIC_API_KEY`), i.e. to where a session on that profile talks anyway.
 *
 * Never throws: `{ models }` or `{ models: [], error }`, so a server that is down (the Mac asleep)
 * shows up as a message beside an empty picker rather than as a failed screen.
 *
 * Node stdlib only; `fetchImpl` is injectable for the tests.
 */
import { resolveProfileEnv, isValidModelId } from './profiles.js';
import { normalizeServerUrl } from './profilesFile.js';

const TIMEOUT_MS = 4000;

// The endpoint's JSON → [{ id, label }], sorted, without duplicates, keeping only ids a launch
// would accept. Embedding models are left out: the endpoint does not say what a model is for, and
// LM Studio lists its embedding model beside the chat ones, where picking it would only fail. A
// profile that names its models itself is not subject to this guess. Pure.
export function parseModelsResponse(json) {
  const rows = json && Array.isArray(json.data) ? json.data : [];
  const seen = new Set();
  const models = [];
  for (const r of rows) {
    const id = r && typeof r.id === 'string' ? r.id : null;
    if (!id || !isValidModelId(id) || /embed/i.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

export async function fetchProfileModels(profile, loginEnv, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!profile || profile.kind !== 'compatible') return { models: [], error: 'not a compatible profile' };
  const { env, errors } = resolveProfileEnv(profile, { env: loginEnv });
  if (errors.length) return { models: [], error: errors.join('; ') };
  const base = String(env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) return { models: [], error: 'ANTHROPIC_BASE_URL is not an http(s) URL' };
  const headers = { Accept: 'application/json' };
  if (env.ANTHROPIC_AUTH_TOKEN) headers.Authorization = 'Bearer ' + env.ANTHROPIC_AUTH_TOKEN;
  else if (env.ANTHROPIC_API_KEY) headers['x-api-key'] = env.ANTHROPIC_API_KEY;
  try {
    // A redirect is not followed: the request carries the profile's credential, which belongs to
    // this server and no other.
    const res = await fetchImpl(base + '/v1/models', { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { models: [], error: `the server answered ${res.status}` };
    return { models: parseModelsResponse(await res.json()) };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { models: [], error: timedOut ? `no answer from ${base} within ${timeoutMs / 1000}s` : `cannot reach ${base}` };
  }
}

/**
 * Asks a server that is not a profile yet what it offers, for the "Add server" form: its models
 * (chat ones), or why it did not answer. `url` is normalized like the one a profile stores.
 * → { baseUrl, models, error? }; never throws.
 */
export async function probeServer(url, token, opts = {}) {
  const baseUrl = normalizeServerUrl(url);
  if (!baseUrl) return { baseUrl: null, models: [], error: 'the address must be an http(s) URL without credentials, e.g. http://127.0.0.1:1234' };
  const env = { ANTHROPIC_BASE_URL: baseUrl };
  if (typeof token === 'string' && token.trim()) env.ANTHROPIC_AUTH_TOKEN = token.trim();
  const r = await fetchProfileModels({ id: 'probe', kind: 'compatible', env }, {}, opts);
  return { baseUrl, ...r };
}
