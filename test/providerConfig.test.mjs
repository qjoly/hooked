/*
 * Pure part of the provider registry (server/providerConfig.js) and of pi's catalog parser
 * (server/piCatalog.js): settings sanitising, model globs, session attribution, capability
 * merge, provider environment.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeProviders, resolveProviders, modelMatches, attributeSession, mergeCapabilities, providerEnv, globToRegExp,
} from '../server/providerConfig.js';
import { parseCatalog, parseTokens } from '../server/piCatalog.js';

describe('sanitizeProviders', () => {
  it('always has the built-ins, as bare mode strings when not customised', () => {
    expect(sanitizeProviders(undefined)).toEqual({ claude: 'auto', pi: 'auto' });
    expect(sanitizeProviders({ claude: 'off', pi: 'on' })).toEqual({ claude: 'off', pi: 'on' });
    expect(sanitizeProviders({ claude: 'garbage', pi: 42 })).toEqual({ claude: 'auto', pi: 'auto' });
  });

  it('keeps customisations of a built-in but never lets it change engine', () => {
    const out = sanitizeProviders({ pi: { enabled: 'on', label: 'Mistral', engine: 'acp', models: ['mistral/*'] } });
    expect(out.pi).toEqual({ enabled: 'on', label: 'Mistral', models: ['mistral/*'] });
    expect(resolveProviders({ pi: { engine: 'acp' } }).find((p) => p.id === 'pi').engine).toBe('pi');
  });

  it('accepts a custom provider only with a valid id and an engine', () => {
    const out = sanitizeProviders({
      gemini: { engine: 'acp', command: 'gemini', args: ['--experimental-acp', 7], label: 'Gemini' },
      'Bad Id': { engine: 'acp' },
      noengine: { label: 'x' },
      'x-y': 'on',
    });
    expect(out.gemini).toEqual({ enabled: 'auto', engine: 'acp', command: 'gemini', args: ['--experimental-acp'], label: 'Gemini' });
    expect(out['Bad Id']).toBeUndefined();
    expect(out.noengine).toBeUndefined();
    expect(out['x-y']).toBeUndefined(); // a string shorthand cannot declare a custom provider
  });

  it('validates every field and drops what is unsafe or malformed', () => {
    const out = sanitizeProviders({
      p: {
        engine: 'pi', short: 'toolong', color: 'red', env: { GOOD_VAR: '1', 'bad-var': '2', EMPTY: '', NUM: 3 },
        models: ['mistral/*', 'bad model'], defaultModel: 'mistral/devstral', titleModel: '', agentDir: 'relative/dir',
        capabilities: { plan: true, bogus: true, trace: 'yes' }, modes: { default: 'ask', 'bad key!': 'x' },
        options: { nested: { ok: true } }, injectHookedMcp: false, description: 'd',
      },
    }).p;
    expect(out.short).toBe('tool'); // a badge is cut to 4 characters
    expect(out.color).toBeUndefined();
    expect(out.env).toEqual({ GOOD_VAR: '1', EMPTY: '' });
    expect(out.models).toEqual(['mistral/*']);
    expect(out.defaultModel).toBe('mistral/devstral');
    expect(out.titleModel).toBe('');
    expect(out.agentDir).toBeUndefined();
    expect(out.capabilities).toEqual({ plan: true });
    expect(out.modes).toEqual({ default: 'ask' });
    expect(out.options).toEqual({ nested: { ok: true } });
    expect(out.injectHookedMcp).toBe(false);
  });

  it('resolves labels and badges, with defaults derived from the id', () => {
    const list = resolveProviders({ 'my-agent': { engine: 'acp' } });
    expect(list.map((p) => p.id)).toEqual(['claude', 'pi', 'my-agent']);
    const mine = list[2];
    expect(mine).toMatchObject({ label: 'My Agent', short: 'my', builtin: false, enabled: 'auto', engine: 'acp' });
    expect(list[0]).toMatchObject({ label: 'Claude', short: 'cc', builtin: true });
  });
});

describe('model globs and attribution', () => {
  it('matches provider/model patterns, and bare patterns on the id alone', () => {
    expect(modelMatches(['mistral/*'], 'mistral/devstral-medium-latest')).toBe(true);
    expect(modelMatches(['mistral/*'], 'anthropic/claude-opus-5-5')).toBe(false);
    expect(modelMatches(['*devstral*'], 'mistral/devstral-medium-latest')).toBe(true);
    expect(modelMatches(['claude-?pus*'], 'anthropic/claude-opus-5-5')).toBe(true);
    expect(modelMatches(['[gm]*'], 'x/glm-5')).toBe(true);
    expect(modelMatches(null, 'anything')).toBe(true);
    expect(modelMatches(['mistral/*'], null)).toBe(false);
    expect(globToRegExp('a.b/*').test('a.b/c')).toBe(true);
    expect(globToRegExp('a.b/*').test('axb/c')).toBe(false);
  });

  it('gives a session to the first filtered provider that matches, else the catch-all', () => {
    const providers = [
      { id: 'pi' },
      { id: 'mistral', models: ['mistral/*'] },
      { id: 'claude-pi', models: ['claude-bridge/*', 'anthropic/*'] },
    ];
    expect(attributeSession(providers, 'mistral/devstral')).toBe('mistral');
    expect(attributeSession(providers, 'anthropic/claude-opus-5-5')).toBe('claude-pi');
    expect(attributeSession(providers, 'openai/gpt-6')).toBe('pi');
    expect(attributeSession(providers, null)).toBe('pi');
    expect(attributeSession([{ id: 'only', models: ['x/*'] }], 'y/z')).toBe('only');
  });
});

describe('capabilities and environment', () => {
  it('merges the engine defaults with the provider overrides', () => {
    const c = mergeCapabilities({ plan: true, trace: true }, { plan: false, todos: true });
    expect(c.plan).toBe(false);
    expect(c.trace).toBe(true);
    expect(c.todos).toBe(true);
    expect(c.subagents).toBe(false);
  });

  it('layers the provider env over the base one, an empty value removing a variable', () => {
    const env = providerEnv({ A: '1', ANTHROPIC_API_KEY: 'secret' }, { env: { B: '2', ANTHROPIC_API_KEY: '' } });
    expect(env).toEqual({ A: '1', B: '2' });
  });
});

describe('pi catalog parser', () => {
  const OUT = [
    'provider  model                     context  max-out  thinking  images',
    'mistral   devstral-medium-latest    262.1K   262.1K   no        no    ',
    'mistral   deepseek-v4-1-flash-1017  1.0M     128K     yes       yes   ',
    'anthropic claude-opus-5-5           1.0M     128K     yes       yes',
    '',
    'some warning line',
  ].join('\n');

  it('parses rows into qualified models with windows and flags', () => {
    const models = parseCatalog(OUT);
    expect(models.map((m) => m.ref)).toEqual([
      'mistral/devstral-medium-latest', 'mistral/deepseek-v4-1-flash-1017', 'anthropic/claude-opus-5-5',
    ]);
    expect(models[0]).toMatchObject({ provider: 'mistral', id: 'devstral-medium-latest', contextWindow: 262100, thinking: false, images: false });
    expect(models[1]).toMatchObject({ contextWindow: 1_000_000, maxOutput: 128_000, thinking: true, images: true });
  });

  it('reads token counts', () => {
    expect(parseTokens('262.1K')).toBe(262100);
    expect(parseTokens('1.0M')).toBe(1_000_000);
    expect(parseTokens('8192')).toBe(8192);
    expect(parseTokens('n/a')).toBe(null);
  });
});
