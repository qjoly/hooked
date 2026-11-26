/*
 * A session resumed, restarted or forked goes back to the connection profile it ran on, never to
 * the default one: that would send a transcript to another account or server. Covers the persisted
 * record, the inheritance in launchSession (refused before any claude process is spawned) and the
 * snapshot's resume arguments. The data dir is a tmpdir of its own, set before agent.js loads:
 * the persisted launch records are written there, not in the shared fixtures.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-profiles-resume-'));
const PREV_DATA_DIR = process.env.HOOKED_DATA_DIR;
process.env.HOOKED_DATA_DIR = DATA_DIR;
afterAll(() => { if (PREV_DATA_DIR === undefined) delete process.env.HOOKED_DATA_DIR; else process.env.HOOKED_DATA_DIR = PREV_DATA_DIR; });

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

const { launchSession, profileOfSession, resumeLaunchArgs, pickResumable } = await import('../server/agent.js');

// An existing fixture session (test/fixtures/projects), so `resumeId` is found.
const SESSION = 'sess-alpha';
const RECORDS = path.join(DATA_DIR, 'session-launch.jsonl');
const record = (profile, id = SESSION) => fs.appendFileSync(RECORDS, JSON.stringify({ ts: 't', session_id: id, model: null, effort: null, profile }) + '\n');
const resume = (extra = {}) => new Promise((res) => launchSession({ resumeId: SESSION, cwd: os.tmpdir(), ...extra }, (err, info) => res({ err, info })));

beforeEach(() => { fs.writeFileSync(RECORDS, ''); });

describe('profileOfSession', () => {
  it('is null for a session with no launch record, and for no id', () => {
    expect(profileOfSession(SESSION)).toBeNull();
    expect(profileOfSession('')).toBeNull();
    expect(profileOfSession(undefined)).toBeNull();
  });

  it('is the profile of the last launch record of the session', () => {
    record('lm');
    expect(profileOfSession(SESSION)).toBe('lm');
    record('default');
    expect(profileOfSession(SESSION)).toBe('default');
  });

  it('reads a record written before profiles existed as no profile', () => {
    fs.appendFileSync(RECORDS, JSON.stringify({ ts: 't', session_id: SESSION, model: 'opus', effort: 'high' }) + '\n');
    expect(profileOfSession(SESSION)).toBeNull();
  });

  it('keeps sessions apart', () => {
    record('lm', 'other-session');
    expect(profileOfSession(SESSION)).toBeNull();
    expect(profileOfSession('other-session')).toBe('lm');
  });
});

describe('launchSession — resuming a session', () => {
  it('goes back to the profile it ran on: validates the model against it', async () => {
    record('lm');
    const { err } = await resume({ model: 'opus' });
    expect(err.message).toBe('unknown model: opus'); // `opus` is a family name, not one of lm's models
  });

  it('refuses to resume on the default profile when the one it ran on is gone', async () => {
    record('gone');
    const { err } = await resume();
    expect(err.code).toBe(400);
    expect(err.message).toBe('profile "gone", the one this session ran on, is no longer configured');
  });

  it('lets the caller name another profile explicitly', async () => {
    record('gone');
    const { err } = await resume({ profile: 'nope' });
    expect(err.message).toBe('unknown profile: nope'); // the explicit one was looked up, not the recorded one
  });

  it('treats a session with no record as the default profile', async () => {
    const { err } = await resume({ model: 'qwen/qwen3-coder-30b' });
    expect(err.message).toBe('unknown model: qwen/qwen3-coder-30b');
  });
});

describe('the snapshot of driven sessions', () => {
  it('hands the profile to the resume', () => {
    const args = resumeLaunchArgs({ id: 'a', cwd: '/tmp/a', effort: 'high', permissionMode: 'plan', autoApprove: true, profile: 'lm' });
    expect(args.profile).toBe('lm');
    expect(args).not.toHaveProperty('model');
  });

  it('leaves it out for a session on no profile (an older snapshot, or the default)', () => {
    expect(resumeLaunchArgs({ id: 'a', cwd: '/tmp/a', profile: null }).profile).toBeUndefined();
    expect(resumeLaunchArgs({ id: 'a', cwd: '/tmp/a' }).profile).toBeUndefined();
  });

  it('keeps the profile of the entries it picks', () => {
    const snap = { ts: new Date().toISOString(), sessions: [{ id: 'a', cwd: '/tmp/a', profile: 'lm' }, { id: 'b', cwd: '/tmp/b', profile: null }] };
    expect(pickResumable(snap).map((s) => s.profile)).toEqual(['lm', null]);
  });
});
