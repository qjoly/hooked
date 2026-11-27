/*
 * Launching and switching models under a connection profile (server/agent.js). Only the paths that
 * are refused before any claude process is spawned, so nothing is launched. The profile lookup is
 * stubbed: the real one reads profiles.json from the data dir.
 */
import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';

const LM = {
  id: 'lm', label: 'LM Studio', kind: 'compatible',
  env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234' },
  models: [{ id: 'qwen/qwen3-coder-30b', label: 'Qwen coder' }],
};

vi.mock('../server/profiles.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findProfile: (id) => {
      if (!id || id === 'default') return actual.defaultProfile();
      return id === 'lm' ? LM : null;
    },
  };
});

const { launchSession, setModelEffort, readLoop, clearAgentState } = await import('../server/agent.js');

const launch = (opts) => new Promise((resolve) => launchSession(opts, (err, info) => resolve({ err, info })));
const CWD = os.tmpdir();

describe('launchSession — profile and model validation', () => {
  it('refuses an unknown profile', async () => {
    const { err } = await launch({ cwd: CWD, profile: 'nope' });
    expect(err.code).toBe(400);
    expect(err.message).toBe('unknown profile: nope');
  });

  it('refuses a profile that is not a string', async () => {
    for (const profile of [42, {}, ['lm'], true]) {
      const { err } = await launch({ cwd: CWD, profile });
      expect(err.code).toBe(400);
      expect(err.message).toBe('invalid profile');
    }
  });

  it('refuses a model the profile does not list', async () => {
    const { err } = await launch({ cwd: CWD, profile: 'lm', model: 'qwen/other' });
    expect(err.code).toBe(400);
    expect(err.message).toBe('unknown model: qwen/other');
  });

  it('refuses a Claude family name on a compatible profile that does not list it', async () => {
    const { err } = await launch({ cwd: CWD, profile: 'lm', model: 'opus' });
    expect(err.message).toBe('unknown model: opus');
  });

  it('keeps refusing a non-Claude model on the default profile, as before', async () => {
    for (const profile of [undefined, null, '', 'default']) {
      const { err } = await launch({ cwd: CWD, profile, model: 'qwen/qwen3-coder-30b' });
      expect(err.code).toBe(400);
      expect(err.message).toBe('unknown model: qwen/qwen3-coder-30b');
    }
  });

  it('validates before creating a worktree for the session', async () => {
    const { err } = await launch({ cwd: CWD, profile: 'nope', worktree: true });
    expect(err.message).toBe('unknown profile: nope');
  });
});

const SESSION = '11111111-2222-3333-4444-555555555555';

// Registers a live session on `profileId`, then runs setModelEffort on it while it is still live
// (readLoop removes it once the stream ends). Resolves with setModelEffort's callback result.
async function switchModelOn(profileId, model) {
  clearAgentState();
  let result = null;
  const st = {
    id: null, launchKey: 'k', cwd: '/tmp/x', profileId,
    input: { close() {} }, abort: { abort() {} }, watchdog: null, readyWaiters: [],
  };
  st.q = (async function* () {
    yield { type: 'system', subtype: 'hook_started', session_id: SESSION };
    setModelEffort(SESSION, { model }, (err, info) => { result = { err, info }; });
  })();
  await readLoop(st);
  return result;
}

describe('setModelEffort — model validation against the session profile', () => {
  it('refuses a model the session\'s profile does not list', async () => {
    const r = await switchModelOn('lm', 'qwen/other');
    expect(r.err.code).toBe(400);
    expect(r.err.message).toBe('unknown model: qwen/other');
  });

  it('refuses a local model id on a session of the default profile', async () => {
    expect((await switchModelOn('default', 'qwen/qwen3-coder-30b')).err.message).toBe('unknown model: qwen/qwen3-coder-30b');
    expect((await switchModelOn(undefined, 'qwen/qwen3-coder-30b')).err.message).toBe('unknown model: qwen/qwen3-coder-30b');
  });

  it('refuses when the session\'s profile has been removed from profiles.json', async () => {
    const r = await switchModelOn('gone', 'opus');
    expect(r.err.code).toBe(400);
    expect(r.err.message).toBe('profile "gone" is no longer configured');
  });
});
