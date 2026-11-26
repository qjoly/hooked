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
  findProfile, isValidModelForProfile, buildSessionEnv, sessionEnvFor, modelToKeepOnFork, profileInfo, isValidModelId, mainConfigDir,
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

describe('findProfile', () => {
  it('finds a profile by id, and the default one for no id', () => {
    const { file } = tmpFile([LMSTUDIO]);
    expect(findProfile('lmstudio-home', file).kind).toBe('compatible');
    expect(findProfile(undefined, file).id).toBe('default');
    expect(findProfile('', file).id).toBe('default');
    expect(findProfile(null, file).id).toBe('default');
  });

  it('returns null for an unknown id, and still knows the default one without a file', () => {
    const { dir, file } = tmpFile([LMSTUDIO]);
    expect(findProfile('nope', file)).toBeNull();
    expect(findProfile('default', path.join(dir, 'absent.json')).id).toBe('default');
  });
});

describe('isValidModelForProfile', () => {
  const anthropic = parseProfiles([{ id: 'work', kind: 'anthropic' }]).profiles[1];
  const listed = parseProfiles([LMSTUDIO]).profiles[1];
  const unlisted = parseProfiles([{ id: 'lm2', kind: 'compatible', env: { ANTHROPIC_BASE_URL: 'http://x' } }]).profiles[1];

  it('gives an anthropic profile the CLI family names, as before', () => {
    for (const m of ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-4-7', 'opus-4-7']) {
      expect(isValidModelForProfile(defaultProfile(), m)).toBe(true);
      expect(isValidModelForProfile(anthropic, m)).toBe(true);
    }
    for (const m of ['qwen/qwen3-coder-30b', 'gpt-5', '', 'opus; rm -rf /']) {
      expect(isValidModelForProfile(defaultProfile(), m)).toBe(false);
    }
  });

  it('limits a compatible profile that lists models to those', () => {
    expect(isValidModelForProfile(listed, 'qwen/qwen3-coder-30b')).toBe(true);
    expect(isValidModelForProfile(listed, 'qwen/qwen3.8-27b')).toBe(true);
    expect(isValidModelForProfile(listed, 'qwen/other')).toBe(false);
    expect(isValidModelForProfile(listed, 'opus')).toBe(false);
  });

  it('accepts any id within the charset when a compatible profile lists none', () => {
    expect(isValidModelForProfile(unlisted, 'qwen/qwen3-coder-30b')).toBe(true);
    expect(isValidModelForProfile(unlisted, 'text-embedding-nomic-embed-text-v1.5')).toBe(true);
    expect(isValidModelForProfile(unlisted, 'a b')).toBe(false);
    expect(isValidModelForProfile(unlisted, '$(id)')).toBe(false);
    expect(isValidModelForProfile(unlisted, '')).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(isValidModelForProfile(defaultProfile(), undefined)).toBe(false);
    expect(isValidModelForProfile(unlisted, 42)).toBe(false);
  });
});

describe('buildSessionEnv', () => {
  const base = {
    PATH: '/usr/bin', HOME: '/home/me', GITHUB_TOKEN: 'gh',
    ANTHROPIC_API_KEY: 'sk-from-shell', ANTHROPIC_BASE_URL: 'https://shell', ANTHROPIC_MODEL: 'opus',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-from-shell', CLAUDE_CONFIG_DIR: '/elsewhere',
  };

  it('leaves the environment of the default profile untouched', () => {
    expect(buildSessionEnv(base, defaultProfile(), {})).toBe(base);
  });

  it('drops the credential variables of the login environment for any other profile', () => {
    const p = parseProfiles([{ id: 'work', kind: 'anthropic' }]).profiles[1];
    expect(buildSessionEnv(base, p, {})).toEqual({
      PATH: '/usr/bin', HOME: '/home/me', GITHUB_TOKEN: 'gh', CLAUDE_CONFIG_DIR: '/elsewhere',
    });
  });

  it('lets the profile env win, and adds to what is kept', () => {
    const p = parseProfiles([LMSTUDIO]).profiles[1];
    const env = buildSessionEnv(base, p, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234', ANTHROPIC_AUTH_TOKEN: 'lmstudio' });
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1234');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('lmstudio');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('keeps a blanked variable blank rather than dropping it', () => {
    const p = parseProfiles([LMSTUDIO]).profiles[1];
    expect(buildSessionEnv(base, p, { ANTHROPIC_API_KEY: '' }).ANTHROPIC_API_KEY).toBe('');
  });

  it('does not mutate the login environment it is given', () => {
    const p = parseProfiles([{ id: 'work', kind: 'anthropic' }]).profiles[1];
    const copy = { ...base };
    buildSessionEnv(base, p, { ANTHROPIC_API_KEY: 'x' });
    expect(base).toEqual(copy);
  });
});

describe('sessionEnvFor', () => {
  it('resolves references against the login environment', () => {
    const p = parseProfiles([{ id: 'work', kind: 'anthropic', env: { ANTHROPIC_API_KEY: { fromEnv: 'WORK_KEY' } } }]).profiles[1];
    const r = sessionEnvFor(p, { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'shell', WORK_KEY: 'work-key' });
    // The shell's own ANTHROPIC_API_KEY is replaced; the source variable, no credential name, stays
    // in the environment as it is in the user's shell.
    expect(r).toEqual({ env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'work-key', WORK_KEY: 'work-key' } });
  });

  it('fails with the profile and the variable named, never the value of another', () => {
    const p = parseProfiles([{ id: 'work', kind: 'anthropic', env: { ANTHROPIC_API_KEY: { fromEnv: 'WORK_KEY' } } }]).profiles[1];
    const r = sessionEnvFor(p, { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-shell-secret' });
    expect(r).toEqual({ error: 'profile "work": ANTHROPIC_API_KEY: $WORK_KEY is not set' });
    expect(JSON.stringify(r)).not.toContain('sk-shell-secret');
  });

  it('hands the default profile the login environment as is', () => {
    const base = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'k' };
    expect(sessionEnvFor(defaultProfile(), base).env).toBe(base);
  });
});

describe('modelToKeepOnFork', () => {
  const compatible = parseProfiles([LMSTUDIO]).profiles[1];
  const anthropic = parseProfiles([{ id: 'work', kind: 'anthropic' }]).profiles[1];

  it('hands a compatible profile the original session\'s model', () => {
    expect(modelToKeepOnFork(compatible, 'qwen/qwen3-coder-30b')).toBe('qwen/qwen3-coder-30b');
  });

  it('leaves the model to the CLI on an anthropic profile and on the default one', () => {
    expect(modelToKeepOnFork(anthropic, 'opus')).toBeUndefined();
    expect(modelToKeepOnFork(defaultProfile(), 'claude-opus-4-7')).toBeUndefined();
  });

  it('drops a model the profile no longer allows, or none', () => {
    expect(modelToKeepOnFork(compatible, 'qwen/removed-from-the-list')).toBeUndefined();
    expect(modelToKeepOnFork(compatible, undefined)).toBeUndefined();
    expect(modelToKeepOnFork(compatible, null)).toBeUndefined();
    expect(modelToKeepOnFork(null, 'opus')).toBeUndefined();
  });
});

describe('profileInfo', () => {
  const { profiles } = parseProfiles([LMSTUDIO]);

  it('is null for the default profile and for a session that predates profiles', () => {
    expect(profileInfo(null, profiles)).toBeNull();
    expect(profileInfo(undefined, profiles)).toBeNull();
    expect(profileInfo('default', profiles)).toBeNull();
  });

  it('names a known profile, without its env or models', () => {
    expect(profileInfo('lmstudio-home', profiles)).toEqual({ id: 'lmstudio-home', label: 'LM Studio (home)', kind: 'compatible' });
  });

  it('still names a profile that was removed from the file, flagged missing', () => {
    expect(profileInfo('gone', profiles)).toEqual({ id: 'gone', label: 'gone', kind: null, missing: true });
  });
});

describe('isValidModelId', () => {
  it('accepts a server model id, publisher prefix included', () => {
    for (const m of ['qwen/qwen3-coder-30b', 'qwen/qwen3.8-27b', 'text-embedding-nomic-embed-text-v1.5', 'llama3:8b']) {
      expect(isValidModelId(m)).toBe(true);
    }
  });
  it('rejects anything that could be interpolated badly', () => {
    for (const m of ['', 'a b', '$(id)', 'a;b', '../x', 42, null]) expect(isValidModelId(m)).toBe(false);
  });
});

describe('contextWindow', () => {
  const compat = (extra) => parseProfiles([{ id: 'lm', kind: 'compatible', env: { ANTHROPIC_BASE_URL: 'http://x' }, ...extra }]);

  it('is kept on a compatible profile', () => {
    expect(compat({ contextWindow: 65536 }).profiles[1].contextWindow).toBe(65536);
    expect(compat({}).profiles[1]).not.toHaveProperty('contextWindow');
  });

  it.each([['a string', '65536'], ['a float', 1000.5], ['too small', 100], ['too large', 1e9], ['negative', -1]])('rejects %s', (_n, v) => {
    const r = compat({ contextWindow: v });
    expect(r.profiles).toHaveLength(1);
    expect(r.errors[0]).toMatch(/contextWindow/);
  });

  it('is refused on an anthropic profile, where it would mean nothing', () => {
    const r = parseProfiles([{ id: 'work', kind: 'anthropic', contextWindow: 65536 }]);
    expect(r.profiles).toHaveLength(1);
    expect(r.errors[0]).toMatch(/only applies to a "compatible" profile/);
  });

  it('is handed to the CLI as its context window, unless the profile\'s own env sets it', () => {
    const p = compat({ contextWindow: 65536 }).profiles[1];
    expect(buildSessionEnv({ PATH: '/bin' }, p, {}).CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('65536');
    expect(buildSessionEnv({ PATH: '/bin' }, p, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '30000' }).CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('30000');
    expect(buildSessionEnv({ PATH: '/bin' }, compat({}).profiles[1], {})).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
  });

  it('does not reach the public shape', () => {
    expect(publicProfile(compat({ contextWindow: 65536 }).profiles[1])).not.toHaveProperty('contextWindow');
  });
});

describe('configDir', () => {
  const HOME = '/home/me';
  const MAIN = '/home/me/.claude';
  const parse = (entries) => parseProfiles(entries, { home: HOME, mainDir: MAIN });
  const acct = (extra) => ({ id: 'perso', kind: 'anthropic', ...extra });

  it('is stored normalized: absolute, `~/` expanded, no trailing slash, no `..`', () => {
    expect(parse([acct({ configDir: '~/accounts/perso' })]).profiles[1].configDir).toBe('/home/me/accounts/perso');
    expect(parse([acct({ configDir: '/data/claude/perso/' })]).profiles[1].configDir).toBe('/data/claude/perso');
    expect(parse([acct({ configDir: '/data/./x/../claude//perso' })]).profiles[1].configDir).toBe('/data/claude/perso');
  });

  it('is absent from a profile that has none', () => {
    expect(parse([acct({})]).profiles[1]).not.toHaveProperty('configDir');
  });

  it.each([
    ['a compatible profile', { id: 'lm', kind: 'compatible', env: { ANTHROPIC_BASE_URL: 'http://x' }, configDir: '/d/x' }, /only applies to an "anthropic" profile/],
    ['a relative path', acct({ configDir: 'accounts/perso' }), /absolute path or start with ~\//],
    ['a non-string', acct({ configDir: 42 }), /absolute path or start with ~\//],
    ['an empty string', acct({ configDir: '' }), /absolute path or start with ~\//],
    ['the root', acct({ configDir: '/' }), /root or the home directory/],
    ['the home directory', acct({ configDir: '~/' }), /root or the home directory/],
    ["the default account's own directory", acct({ configDir: '~/.claude/' }), /default account's own directory/],
  ])('rejects %s', (_n, entry, message) => {
    const r = parse([entry]);
    expect(r.profiles).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(message);
  });

  it('knows the default account\'s directory from CLAUDE_CONFIG_DIR when it is set', () => {
    expect(mainConfigDir({}, HOME)).toBe('/home/me/.claude');
    expect(mainConfigDir({ CLAUDE_CONFIG_DIR: '/opt/claude/' }, HOME)).toBe('/opt/claude');
    const r = parseProfiles([acct({ configDir: '/opt/claude' })], { home: HOME, mainDir: mainConfigDir({ CLAUDE_CONFIG_DIR: '/opt/claude' }, HOME) });
    expect(r.errors[0]).toMatch(/default account's own directory/);
  });

  it('cannot be shared by two profiles, however the path is written', () => {
    const r = parse([acct({ configDir: '~/a/x' }), acct({ id: 'second', configDir: '/home/me/a/x/' })]);
    expect(r.profiles.map((p) => p.id)).toEqual(['default', 'perso']);
    expect(r.errors).toEqual([expect.stringMatching(/already used by profile "perso"/)]);
  });

  it('is handed to the CLI as CLAUDE_CONFIG_DIR, over the login environment\'s', () => {
    const p = parse([acct({ configDir: '~/a/perso' })]).profiles[1];
    const env = buildSessionEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/elsewhere' }, p, {});
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/me/a/perso');
    expect(env.PATH).toBe('/bin');
  });

  it('yields to a CLAUDE_CONFIG_DIR the profile\'s own env sets, and to nothing else', () => {
    const p = parse([acct({ configDir: '~/a/perso' })]).profiles[1];
    expect(buildSessionEnv({}, p, { CLAUDE_CONFIG_DIR: '/explicit' }).CLAUDE_CONFIG_DIR).toBe('/explicit');
  });

  it('leaves the login environment\'s CLAUDE_CONFIG_DIR alone for a profile without one', () => {
    const p = parse([acct({})]).profiles[1];
    expect(buildSessionEnv({ CLAUDE_CONFIG_DIR: '/elsewhere' }, p, {}).CLAUDE_CONFIG_DIR).toBe('/elsewhere');
  });

  it('does not reach the public shape', () => {
    expect(JSON.stringify(publicProfile(parse([acct({ configDir: '~/a/perso' })]).profiles[1]))).not.toContain('perso/');
  });
});
