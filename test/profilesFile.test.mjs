/*
 * Adding an account to profiles.json (server/profilesFile.js): the id it gets, the entry it writes,
 * and the care taken with the user's file. All on a tmpdir.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slugify, uniqueProfileId, addAccountProfile, addServerProfile, normalizeServerUrl, parseServerUrl } from '../server/profilesFile.js';
import { loadProfiles } from '../server/profiles.js';

const setup = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-profilesfile-'));
  const file = path.join(dir, 'data', 'profiles.json');
  if (content !== undefined) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); }
  return { dir, file, accountsRoot: path.join(dir, 'data', 'accounts') };
};
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('slugify', () => {
  it('makes a lowercase id of letters, digits and single dashes', () => {
    expect(slugify('Perso (Outlook)')).toBe('perso-outlook');
    expect(slugify('  Compte  Pro  ')).toBe('compte-pro');
    expect(slugify('Équipe Données')).toBe('equipe-donnees');
  });
  it('never comes out empty', () => {
    for (const l of ['', '   ', '!!!', '日本語', null, undefined]) expect(slugify(l)).toBe('account');
  });
  it('stays within the room it is given, with no dash left hanging', () => {
    const s = slugify('a'.repeat(50) + ' b');
    expect(s.length).toBeLessThanOrEqual(32);
    expect(slugify('abcdefgh-ijkl', 9)).toBe('abcdefgh');
  });
});

describe('uniqueProfileId', () => {
  it('is the slug when it is free', () => {
    expect(uniqueProfileId('Perso', ['work'])).toBe('perso');
  });
  it('numbers it when taken, and never takes the reserved id', () => {
    expect(uniqueProfileId('Perso', ['perso'])).toBe('perso-2');
    expect(uniqueProfileId('Perso', ['perso', 'perso-2'])).toBe('perso-3');
    expect(uniqueProfileId('Default', [])).toBe('default-2');
  });
  it('keeps the numbered id within the length limit', () => {
    const long = 'x'.repeat(40);
    const first = uniqueProfileId(long, []);
    const second = uniqueProfileId(long, [first]);
    expect(first).toHaveLength(32);
    expect(second.length).toBeLessThanOrEqual(32);
    expect(second.endsWith('-2')).toBe(true);
  });
});

describe('addAccountProfile', () => {
  it('creates the file when there is none, with the entry and its directory under accountsRoot', () => {
    const { file, accountsRoot } = setup();
    const r = addAccountProfile('Perso', { file, accountsRoot });
    expect(r.error).toBeUndefined();
    expect(r.profile).toEqual({ id: 'perso', label: 'Perso', kind: 'anthropic', models: [], implicit: false, hasAccount: true });
    expect(read(file)).toEqual([{ id: 'perso', label: 'Perso', kind: 'anthropic', configDir: path.join(accountsRoot, 'perso') }]);
  });

  it('writes an entry the loader accepts', () => {
    const { file, accountsRoot } = setup();
    addAccountProfile('Perso', { file, accountsRoot });
    const { profiles, errors } = loadProfiles(file);
    expect(errors).toEqual([]);
    expect(profiles.map((p) => p.id)).toEqual(['default', 'perso']);
    expect(profiles[1].configDir).toBe(path.join(accountsRoot, 'perso'));
  });

  it('appends to the existing entries as they are, unknown keys included', () => {
    const existing = [{ id: 'lm', kind: 'compatible', env: { ANTHROPIC_BASE_URL: 'http://x' }, futureKey: { keep: 'me' } }];
    const { file, accountsRoot } = setup(existing);
    addAccountProfile('Perso', { file, accountsRoot });
    const out = read(file);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(existing[0]);
    expect(out[1].id).toBe('perso');
  });

  it('numbers the id and the directory when the name is already taken', () => {
    const { file, accountsRoot } = setup();
    addAccountProfile('Perso', { file, accountsRoot });
    const r = addAccountProfile('Perso', { file, accountsRoot });
    expect(r.profile.id).toBe('perso-2');
    const out = read(file);
    expect(out.map((p) => p.id)).toEqual(['perso', 'perso-2']);
    expect(out[0].configDir).not.toBe(out[1].configDir);
  });

  it('refuses an empty or too long name, writing nothing', () => {
    const { file, accountsRoot } = setup();
    for (const label of ['', '   ', undefined, null, 42]) expect(addAccountProfile(label, { file, accountsRoot }).error).toMatch(/name is required/);
    expect(addAccountProfile('x'.repeat(61), { file, accountsRoot }).error).toMatch(/too long/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses to touch a file that is not a JSON array, leaving it as it is', () => {
    for (const content of ['{ not json', '{"profiles":[]}', '"text"']) {
      const { file, accountsRoot } = setup(content);
      const r = addAccountProfile('Perso', { file, accountsRoot });
      expect(r.error).toMatch(/left as it is/);
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    }
  });

  it('refuses a directory another profile already uses, writing nothing', () => {
    const { file, accountsRoot } = setup();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([{ id: 'other', kind: 'anthropic', configDir: path.join(accountsRoot, 'perso') }]));
    const before = fs.readFileSync(file, 'utf8');
    const r = addAccountProfile('Perso', { file, accountsRoot });
    expect(r.error).toMatch(/already used by profile "other"/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('leaves no temporary file behind', () => {
    const { file, accountsRoot } = setup();
    addAccountProfile('Perso', { file, accountsRoot });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['profiles.json']);
  });
});

describe('profiles.json is private', () => {
  const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);

  it('is created 0600 by an account, and by a server', () => {
    const a = setup();
    addAccountProfile('Perso', { file: a.file, accountsRoot: a.accountsRoot });
    expect(mode(a.file)).toBe('600');
    const b = setup();
    addServerProfile('LM', { url: 'http://127.0.0.1:1234' }, { file: b.file });
    expect(mode(b.file)).toBe('600');
  });

  it('is tightened when it was left readable by others, as an earlier version did', () => {
    const { file, accountsRoot } = setup([]);
    fs.chmodSync(file, 0o644);
    addAccountProfile('Perso', { file, accountsRoot });
    expect(mode(file)).toBe('600');
  });
});

describe('normalizeServerUrl', () => {
  it('keeps an origin, with or without a trailing slash', () => {
    expect(normalizeServerUrl('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234');
    expect(normalizeServerUrl(' http://mew:1234/ ')).toBe('http://mew:1234');
  });
  it('drops the /v1 of an OpenAI-style address, which the CLI adds its own path to', () => {
    expect(normalizeServerUrl('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234');
    expect(normalizeServerUrl('https://x.example/lm/v1/')).toBe('https://x.example/lm');
  });
  it('drops a query and a fragment', () => {
    expect(normalizeServerUrl('http://h:1/p?key=SECRET#f')).toBe('http://h:1/p');
  });
  it.each([[''], ['ftp://h'], ['file:///etc/passwd'], ['http://user:pw@h:1'], [null], [undefined], ['http://'], ['://x'], ['a b c']])('refuses %j', (v) => {
    expect(normalizeServerUrl(v)).toBeNull();
  });

  it('takes an address typed without a scheme as http://, which is what a local server is', () => {
    expect(normalizeServerUrl('mew.net.lilian-arago.com:1234')).toBe('http://mew.net.lilian-arago.com:1234');
    expect(normalizeServerUrl('mew:1234')).toBe('http://mew:1234');
    expect(normalizeServerUrl('localhost:1234/v1')).toBe('http://localhost:1234');
    expect(normalizeServerUrl('192.168.1.50:1234')).toBe('http://192.168.1.50:1234');
    expect(normalizeServerUrl('lm.example.com')).toBe('http://lm.example.com');
  });

  it('keeps https, and a scheme in any case', () => {
    expect(normalizeServerUrl('https://lm.example.com')).toBe('https://lm.example.com');
    expect(normalizeServerUrl('HTTP://Mew:1234')).toBe('http://mew:1234');
  });
});

describe('parseServerUrl — what is said when it is refused', () => {
  const err = (v) => parseServerUrl(v).error;
  it('asks for an address when there is none', () => {
    for (const v of ['', '   ', null, undefined]) expect(err(v)).toMatch(/Enter the server's address/);
  });
  it('names the real problem, never "http(s) URL without credentials" for something else', () => {
    expect(err('ftp://h')).toBe('Only http:// and https:// addresses are supported.');
    expect(err('file:///etc/passwd')).toBe('Only http:// and https:// addresses are supported.');
    expect(err('http://user:pw@h:1')).toMatch(/Remove the user name and password.*Token field/);
    expect(err('a b c')).toMatch(/does not look like an address/);
  });
  it('quotes what was typed, so a typo can be spotted', () => {
    expect(err('a b c')).toContain('“a b c”');
  });
  it('gives the URL when it is fine, and no error', () => {
    expect(parseServerUrl('mew:1234')).toEqual({ url: 'http://mew:1234' });
  });
});

describe('addServerProfile', () => {
  const lm = (over = {}) => ({ url: 'http://127.0.0.1:1234', ...over });

  it('writes a compatible profile the loader accepts, with the default dummy token', () => {
    const { file } = setup();
    const r = addServerProfile('LM Studio (mac)', lm(), { file });
    expect(r.error).toBeUndefined();
    expect(r.profile).toEqual({ id: 'lm-studio-mac', label: 'LM Studio (mac)', kind: 'compatible', models: [], implicit: false, hasAccount: false });
    expect(read(file)).toEqual([{
      id: 'lm-studio-mac', label: 'LM Studio (mac)', kind: 'compatible',
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234', ANTHROPIC_AUTH_TOKEN: 'lmstudio', ANTHROPIC_API_KEY: '' },
    }]);
    expect(loadProfiles(file).errors).toEqual([]);
  });

  it('stores a token, a context window and the chosen models', () => {
    const { file } = setup();
    addServerProfile('LM', lm({ token: ' sk-1 ', contextWindow: 65536, models: ['qwen/a', 'qwen/b'] }), { file });
    const [e] = read(file);
    expect(e.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-1');
    expect(e.contextWindow).toBe(65536);
    expect(e.models).toEqual(['qwen/a', 'qwen/b']);
    const p = loadProfiles(file).profiles[1];
    expect(p.contextWindow).toBe(65536);
    expect(p.models.map((m) => m.id)).toEqual(['qwen/a', 'qwen/b']);
  });

  it('leaves out an empty model list and an empty context window', () => {
    const { file } = setup();
    addServerProfile('LM', lm({ models: [], contextWindow: '' }), { file });
    const [e] = read(file);
    expect(e).not.toHaveProperty('models');
    expect(e).not.toHaveProperty('contextWindow');
  });

  it('stores the address normalized', () => {
    const { file } = setup();
    addServerProfile('LM', lm({ url: 'http://127.0.0.1:1234/v1/' }), { file });
    expect(read(file)[0].env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1234');
  });

  it('numbers the id for a second server of the same name, and keeps the existing entries as they are', () => {
    const existing = [{ id: 'lucca', kind: 'anthropic', futureKey: 1 }];
    const { file } = setup(existing);
    addServerProfile('LM', lm(), { file });
    const r = addServerProfile('LM', lm({ url: 'http://mew:1234' }), { file });
    expect(r.profile.id).toBe('lm-2');
    const out = read(file);
    expect(out[0]).toEqual(existing[0]);
    expect(out.map((p) => p.id)).toEqual(['lucca', 'lm', 'lm-2']);
  });

  it.each([
    ['no name', '  ', lm(), /name is required/],
    ['no address', 'LM', {}, /Enter the server's address/],
    ['an address with credentials', 'LM', lm({ url: 'http://u:p@h:1' }), /Remove the user name and password/],
    ['a context window that is not a number', 'LM', lm({ contextWindow: 'big' }), /contextWindow/],
    ['a context window that is too small', 'LM', lm({ contextWindow: 100 }), /contextWindow/],
    ['an invalid model id', 'LM', lm({ models: ['a b'] }), /invalid model id/],
  ])('refuses %s, writing nothing', (_n, label, opts, message) => {
    const { file } = setup();
    expect(addServerProfile(label, opts, { file }).error).toMatch(message);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses to touch a file that is not a JSON array', () => {
    const { file } = setup('{ nope');
    expect(addServerProfile('LM', lm(), { file }).error).toMatch(/left as it is/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ nope');
  });
});
