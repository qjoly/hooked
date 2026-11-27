/*
 * Moving a session to another connection profile: the rule (planProfileMove, pure) and the refusals
 * of moveSession, which are all decided before any process is stopped or started.
 */
import { describe, it, expect, vi } from 'vitest';
import { planProfileMove, parseProfiles, defaultProfile } from '../server/profiles.js';

const { profiles } = parseProfiles([
  { id: 'lucca', kind: 'anthropic', configDir: '/d/accounts/lucca' },
  { id: 'work', kind: 'anthropic', configDir: '/d/accounts/work' },
  { id: 'lm', kind: 'compatible', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234' }, models: ['qwen/qwen3-coder-30b'] },
  { id: 'lm2', kind: 'compatible', env: { ANTHROPIC_BASE_URL: 'http://mew:1234' } },
], { home: '/h', mainDir: '/h/.claude' });
const by = (id) => profiles.find((p) => p.id === id);
const MAIN = defaultProfile();

describe('planProfileMove', () => {
  it('moves between two Anthropic accounts with nothing to pick: the CLI restores the model', () => {
    expect(planProfileMove({ source: MAIN, target: by('lucca'), currentEffort: 'high' }))
      .toEqual({ profile: 'lucca', model: undefined, effort: 'high', dropEffort: false });
    expect(planProfileMove({ source: null, target: by('work') }).profile).toBe('work');
    expect(planProfileMove({ source: by('lucca'), target: MAIN }).profile).toBe('default');
  });

  it('keeps the effort asked for, over the session\'s own', () => {
    expect(planProfileMove({ source: MAIN, target: by('lucca'), effort: 'max', currentEffort: 'high' }).effort).toBe('max');
  });

  it('needs a model of the server to move onto a server', () => {
    expect(planProfileMove({ source: MAIN, target: by('lm') }).error).toMatch(/Pick one of the server's models/);
    const ok = planProfileMove({ source: MAIN, target: by('lm'), model: 'qwen/qwen3-coder-30b', currentEffort: 'high' });
    expect(ok).toEqual({ profile: 'lm', model: 'qwen/qwen3-coder-30b', effort: undefined, dropEffort: true });
  });

  it('refuses a model the server does not list, and a Claude name for a server', () => {
    expect(planProfileMove({ source: MAIN, target: by('lm'), model: 'qwen/other' }).error).toBe('unknown model: qwen/other');
    expect(planProfileMove({ source: MAIN, target: by('lm'), model: 'opus' }).error).toBe('unknown model: opus');
  });

  it('accepts any well-formed id for a server that lists none', () => {
    expect(planProfileMove({ source: MAIN, target: by('lm2'), model: 'whatever/model-1' }).model).toBe('whatever/model-1');
  });

  it('needs a Claude model to move from a server to an account, and refuses the server\'s own name', () => {
    expect(planProfileMove({ source: by('lm'), target: by('lucca') }).error).toMatch(/Pick a model/);
    expect(planProfileMove({ source: by('lm'), target: MAIN, model: 'qwen/qwen3-coder-30b' }).error).toBe('unknown model: qwen/qwen3-coder-30b');
    expect(planProfileMove({ source: by('lm'), target: by('lucca'), model: 'sonnet', effort: 'high' }))
      .toEqual({ profile: 'lucca', model: 'sonnet', effort: 'high', dropEffort: false });
  });

  it('needs a model from one server to another too', () => {
    expect(planProfileMove({ source: by('lm'), target: by('lm2') }).error).toMatch(/Pick one of the server's models/);
  });

  it('treats a profile that was removed (kind unknown) as a server, so a model is asked for', () => {
    const gone = { id: 'gone', kind: 'compatible' };
    expect(planProfileMove({ source: gone, target: MAIN }).error).toMatch(/Pick a model/);
    expect(planProfileMove({ source: gone, target: MAIN, model: 'opus' }).profile).toBe('default');
  });

  it('refuses the profile the session is already on, and one that does not exist', () => {
    expect(planProfileMove({ source: by('lucca'), target: by('lucca') }).error).toBe('The session already runs on that profile.');
    expect(planProfileMove({ source: null, target: MAIN }).error).toBe('The session already runs on that profile.');
    expect(planProfileMove({ source: MAIN, target: null }).error).toBe('unknown profile');
  });
});

describe('moveSession — refusals, before anything is stopped', () => {
  vi.mock('../server/profiles.js', async (importOriginal) => {
    const actual = await importOriginal();
    const ACCOUNT = { id: 'lucca', kind: 'anthropic', env: {}, models: [], configDir: '/d/accounts/lucca' };
    const SERVER = { id: 'lm', kind: 'compatible', env: { ANTHROPIC_BASE_URL: 'http://x' }, models: [{ id: 'qwen/a', label: 'a' }] };
    return { ...actual, findProfile: (id) => (!id || id === 'default' ? actual.defaultProfile() : id === 'lucca' ? ACCOUNT : id === 'lm' ? SERVER : null) };
  });
  const move = async (id, opts) => {
    const { moveSession } = await import('../server/agent.js');
    return new Promise((res) => moveSession(id, opts, (err, info) => res({ err, info })));
  };

  it('refuses an invalid id and a session that does not exist', async () => {
    expect((await move('../x', { profile: 'lucca' })).err.message).toBe('invalid session id');
    expect((await move('no-such-session', { profile: 'lucca' })).err.message).toBe('session not found');
  });

  it('refuses a profile that does not exist, on a session that does', async () => {
    const r = await move('sess-alpha', { profile: 'nope' });
    expect(r.err.code).toBe(400);
    expect(r.err.message).toBe('unknown profile');
  });

  it('asks for a model before moving onto a server, and refuses one that is not the server\'s', async () => {
    expect((await move('sess-alpha', { profile: 'lm' })).err.message).toMatch(/Pick one of the server's models/);
    expect((await move('sess-alpha', { profile: 'lm', model: 'opus' })).err.message).toBe('unknown model: opus');
  });

  it('refuses to move a session onto the profile it is on (the default one, with no record)', async () => {
    expect((await move('sess-alpha', { profile: 'default' })).err.message).toBe('The session already runs on that profile.');
  });
});
