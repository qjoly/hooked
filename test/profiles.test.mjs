/*
 * Connection profiles (server/profiles.js): the parser, the loader, the public shape and the
 * secret references. All pure or on a tmpdir: no session is launched.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseProfiles, loadProfiles, profilesOverview, publicProfile, resolveProfileEnv, defaultProfile,
} from '../server/profiles.js';

const LMSTUDIO = {
  id: 'lmstudio-home',
  label: 'LM Studio (home)',
  kind: 'compatible',
  env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234', ANTHROPIC_AUTH_TOKEN: 'lmstudio' },
  models: ['qwen/qwen3-coder-30b', { id: 'qwen/qwen3.8-27b', label: 'Qwen 27B' }],
};

const tmpFile = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-profiles-'));
  const file = path.join(dir, 'profiles.json');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return { dir, file };
};

describe('parseProfiles', () => {
  it('always puts the implicit default profile first', () => {
    const { profiles, errors } = parseProfiles([LMSTUDIO]);
    expect(errors).toEqual([]);
    expect(profiles.map((p) => p.id)).toEqual(['default', 'lmstudio-home']);
    expect(profiles[0]).toEqual(defaultProfile());
    expect(profiles[0].env).toEqual({});
  });

  it('normalizes models to { id, label } and drops duplicates', () => {
    const { profiles } = parseProfiles([{ ...LMSTUDIO, models: ['a/b', { id: 'a/b' }, { id: 'c', label: ' C ' }] }]);
    expect(profiles[1].models).toEqual([{ id: 'a/b', label: 'a/b' }, { id: 'c', label: 'C' }]);
  });

  it('defaults the label to the id', () => {
    const { profiles } = parseProfiles([{ id: 'work', kind: 'anthropic' }]);
    expect(profiles[1]).toMatchObject({ id: 'work', label: 'work', kind: 'anthropic', env: {}, models: [] });
  });

  it('accepts literal, fromEnv and file env values, and an empty literal to blank a variable', () => {
    const { profiles, errors } = parseProfiles([{
      id: 'work', kind: 'anthropic',
      env: { A: 'x', B: { fromEnv: 'WORK_TOKEN' }, C: { file: '~/t' }, D: { file: '/etc/t' }, E: '' },
    }]);
    expect(errors).toEqual([]);
    expect(profiles[1].env).toEqual({ A: 'x', B: { fromEnv: 'WORK_TOKEN' }, C: { file: '~/t' }, D: { file: '/etc/t' }, E: '' });
  });

  it.each([
    ['a non-object entry', 'nope', /must be an object/],
    ['an invalid id', { id: 'Bad Id', kind: 'anthropic' }, /invalid "id"/],
    ['the reserved id', { id: 'default', kind: 'anthropic' }, /reserved/],
    ['an unknown kind', { id: 'x', kind: 'openai' }, /"kind" must be one of/],
    ['a non-string label', { id: 'x', kind: 'anthropic', label: 3 }, /"label"/],
    ['a bad env variable name', { id: 'x', kind: 'anthropic', env: { 'A-B': '1' } }, /invalid env variable name/],
    ['a numeric env value', { id: 'x', kind: 'anthropic', env: { A: 1 } }, /env A: must be a string/],
    ['a reference with two keys', { id: 'x', kind: 'anthropic', env: { A: { fromEnv: 'X', file: '/f' } } }, /exactly one key/],
    ['an unknown reference', { id: 'x', kind: 'anthropic', env: { A: { cmd: 'echo' } } }, /exactly one key/],
    ['a bad fromEnv name', { id: 'x', kind: 'anthropic', env: { A: { fromEnv: 'a b' } } }, /variable name/],
    ['a relative file path', { id: 'x', kind: 'anthropic', env: { A: { file: 'token' } } }, /absolute path or start with ~\//],
    ['a model id with a space', { id: 'x', kind: 'anthropic', models: ['a b'] }, /invalid model id/],
    ['a non-array models', { id: 'x', kind: 'anthropic', models: 'a' }, /"models" must be an array/],
    ['a compatible profile without a base URL', { id: 'x', kind: 'compatible', env: {} }, /ANTHROPIC_BASE_URL/],
  ])('skips and reports %s', (_name, entry, message) => {
    const { profiles, errors } = parseProfiles([entry]);
    expect(profiles.map((p) => p.id)).toEqual(['default']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(message);
  });

  it('keeps the valid entries around a bad one, and names the bad one', () => {
    const { profiles, errors } = parseProfiles([LMSTUDIO, { id: 'bad', kind: 'nope' }, { id: 'work', kind: 'anthropic' }]);
    expect(profiles.map((p) => p.id)).toEqual(['default', 'lmstudio-home', 'work']);
    expect(errors).toEqual([expect.stringMatching(/^profile #2 \(bad\):/)]);
  });

  it('reports a duplicate id and keeps the first', () => {
    const { profiles, errors } = parseProfiles([LMSTUDIO, { ...LMSTUDIO, label: 'second' }]);
    expect(profiles).toHaveLength(2);
    expect(profiles[1].label).toBe('LM Studio (home)');
    expect(errors).toEqual([expect.stringMatching(/duplicate id/)]);
  });

  it('rejects a document that is not an array', () => {
    const { profiles, errors } = parseProfiles({ profiles: [] });
    expect(profiles).toEqual([defaultProfile()]);
    expect(errors).toEqual([expect.stringMatching(/JSON array/)]);
  });
});

describe('loadProfiles', () => {
  it('returns only the default profile when the file does not exist', () => {
    const { dir } = tmpFile();
    expect(loadProfiles(path.join(dir, 'profiles.json'))).toEqual({ profiles: [defaultProfile()], errors: [] });
  });

  it('reads the file on every call', () => {
    const { file } = tmpFile([LMSTUDIO]);
    expect(loadProfiles(file).profiles).toHaveLength(2);
    fs.writeFileSync(file, '[]');
    expect(loadProfiles(file).profiles).toHaveLength(1);
  });

  it('never throws on invalid JSON', () => {
    const { file } = tmpFile('{ not json');
    const r = loadProfiles(file);
    expect(r.profiles).toEqual([defaultProfile()]);
    expect(r.errors).toEqual([expect.stringMatching(/not valid JSON/)]);
  });

  it('never throws on an unreadable file', () => {
    const { dir } = tmpFile();
    const r = loadProfiles(dir); // a directory: EISDIR, not ENOENT
    expect(r.profiles).toEqual([defaultProfile()]);
    expect(r.errors).toEqual([expect.stringMatching(/cannot read/)]);
  });
});

describe('the public shape', () => {
  it('carries no env, whatever the profile holds', () => {
    const secret = 'sk-ant-super-secret';
    const { file } = tmpFile([{
      id: 'work', kind: 'anthropic',
      env: { ANTHROPIC_API_KEY: secret, OTHER: { fromEnv: 'WORK_KEY_VAR' }, THIRD: { file: '/run/secrets/work-key' } },
    }]);
    const overview = profilesOverview(file);
    const text = JSON.stringify(overview);
    for (const needle of [secret, 'WORK_KEY_VAR', '/run/secrets/work-key', 'ANTHROPIC_API_KEY', 'env']) {
      expect(text).not.toContain(needle);
    }
    expect(overview.profiles.map((p) => p.id)).toEqual(['default', 'work']);
  });

  it('exposes id, label, kind, models and whether the profile is implicit', () => {
    const { profiles } = parseProfiles([LMSTUDIO]);
    expect(publicProfile(profiles[0])).toEqual({ id: 'default', label: 'Default', kind: 'anthropic', models: [], implicit: true });
    expect(publicProfile(profiles[1])).toEqual({
      id: 'lmstudio-home', label: 'LM Studio (home)', kind: 'compatible', implicit: false,
      models: [{ id: 'qwen/qwen3-coder-30b', label: 'qwen/qwen3-coder-30b' }, { id: 'qwen/qwen3.8-27b', label: 'Qwen 27B' }],
    });
  });
});

describe('resolveProfileEnv', () => {
  const profile = (env) => ({ id: 'p', kind: 'anthropic', env });

  it('passes literals through, including an empty one', () => {
    expect(resolveProfileEnv(profile({ A: 'x', B: '' }))).toEqual({ env: { A: 'x', B: '' }, errors: [] });
  });

  it('resolves fromEnv against the given environment', () => {
    const r = resolveProfileEnv(profile({ KEY: { fromEnv: 'WORK_KEY' } }), { env: { WORK_KEY: 'abc' } });
    expect(r).toEqual({ env: { KEY: 'abc' }, errors: [] });
  });

  it('reads a file, expands ~/ and drops one trailing newline', () => {
    const reads = [];
    const readFile = (f) => { reads.push(f); return 'tok\n'; };
    const r = resolveProfileEnv(profile({ A: { file: '~/.config/t' }, B: { file: '/etc/t' } }), { readFile, home: '/home/me' });
    expect(r).toEqual({ env: { A: 'tok', B: 'tok' }, errors: [] });
    expect(reads).toEqual(['/home/me/.config/t', '/etc/t']);
  });

  it('reports an unset variable, a missing file and an empty file, naming them but never a value', () => {
    const readFile = (f) => { if (f === '/empty') return '\n'; throw new Error('ENOENT'); };
    const r = resolveProfileEnv(
      profile({ A: { fromEnv: 'UNSET' }, B: { file: '/missing' }, C: { file: '/empty' }, OK: 'fine' }),
      { env: {}, readFile },
    );
    expect(r.env).toEqual({ OK: 'fine' });
    expect(r.errors).toEqual([
      'A: $UNSET is not set',
      'B: /missing is missing or empty',
      'C: /empty is missing or empty',
    ]);
  });

  it('resolves the default profile to an empty env', () => {
    expect(resolveProfileEnv(defaultProfile())).toEqual({ env: {}, errors: [] });
  });
});
