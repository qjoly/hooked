/*
 * The models a compatible profile's server offers (server/profileModels.js): the response parser
 * and the fetch, with an injected fetch (nothing leaves the machine).
 */
import { describe, it, expect } from 'vitest';
import { parseModelsResponse, fetchProfileModels } from '../server/profileModels.js';
import { parseProfiles } from '../server/profiles.js';

const compat = (env, models) => parseProfiles([{ id: 'lm', kind: 'compatible', env, models }]).profiles[1];
const LM = compat({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234/', ANTHROPIC_AUTH_TOKEN: 'lmstudio' });
const reply = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('parseModelsResponse', () => {
  it('lists the ids, sorted, without duplicates', () => {
    const r = parseModelsResponse({ data: [{ id: 'qwen/b' }, { id: 'qwen/a' }, { id: 'qwen/b' }] });
    expect(r).toEqual([{ id: 'qwen/a', label: 'qwen/a' }, { id: 'qwen/b', label: 'qwen/b' }]);
  });

  it('drops ids a launch would refuse, and malformed rows', () => {
    const r = parseModelsResponse({ data: [{ id: 'ok/model' }, { id: 'a b' }, { id: '$(x)' }, { id: 3 }, null, {}] });
    expect(r.map((m) => m.id)).toEqual(['ok/model']);
  });

  it('leaves embedding models out, which cannot chat', () => {
    const r = parseModelsResponse({ data: [{ id: 'text-embedding-nomic-embed-text-v1.5' }, { id: 'qwen/qwen3-coder-30b' }, { id: 'nomic-embed-text' }] });
    expect(r.map((m) => m.id)).toEqual(['qwen/qwen3-coder-30b']);
  });

  it('copes with anything else', () => {
    for (const j of [null, undefined, {}, { data: 'x' }, []]) expect(parseModelsResponse(j)).toEqual([]);
  });
});

describe('fetchProfileModels', () => {
  it('asks the profile\'s own /v1/models with its token, whatever the trailing slash', async () => {
    let seen = null;
    const fetchImpl = async (url, init) => { seen = { url, init }; return reply({ data: [{ id: 'qwen/a' }] })(); };
    const r = await fetchProfileModels(LM, {}, { fetchImpl });
    expect(r).toEqual({ models: [{ id: 'qwen/a', label: 'qwen/a' }] });
    expect(seen.url).toBe('http://127.0.0.1:1234/v1/models');
    expect(seen.init.headers.Authorization).toBe('Bearer lmstudio');
  });

  it('sends an API key as x-api-key when there is no token', async () => {
    let headers = null;
    const p = compat({ ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_API_KEY: { fromEnv: 'K' } });
    await fetchProfileModels(p, { K: 'sk-1' }, { fetchImpl: async (u, init) => { headers = init.headers; return reply({ data: [] })(); } });
    expect(headers['x-api-key']).toBe('sk-1');
    expect(headers.Authorization).toBeUndefined();
  });

  it('refuses a profile that is not compatible, without any request', async () => {
    let called = false;
    const anthropic = parseProfiles([{ id: 'work', kind: 'anthropic' }]).profiles[1];
    const r = await fetchProfileModels(anthropic, {}, { fetchImpl: async () => { called = true; } });
    expect(r.error).toMatch(/not a compatible profile/);
    expect(called).toBe(false);
  });

  it('reports an unresolved reference by name, without any request', async () => {
    let called = false;
    const p = compat({ ANTHROPIC_BASE_URL: 'http://x', ANTHROPIC_AUTH_TOKEN: { fromEnv: 'NOPE' } });
    const r = await fetchProfileModels(p, {}, { fetchImpl: async () => { called = true; } });
    expect(r).toEqual({ models: [], error: 'ANTHROPIC_AUTH_TOKEN: $NOPE is not set' });
    expect(called).toBe(false);
  });

  it('refuses a base URL that is not http(s)', async () => {
    const p = compat({ ANTHROPIC_BASE_URL: 'file:///etc/passwd' });
    expect((await fetchProfileModels(p, {}, { fetchImpl: async () => { throw new Error('no'); } })).error).toMatch(/not an http\(s\) URL/);
  });

  it('turns a failing server into a message, never a throw', async () => {
    expect(await fetchProfileModels(LM, {}, { fetchImpl: reply({}, 503) })).toEqual({ models: [], error: 'the server answered 503' });
    const down = await fetchProfileModels(LM, {}, { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    expect(down).toEqual({ models: [], error: 'cannot reach http://127.0.0.1:1234' });
    const slow = await fetchProfileModels(LM, {}, { fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }, timeoutMs: 1000 });
    expect(slow.error).toBe('no answer from http://127.0.0.1:1234 within 1s');
  });
});
