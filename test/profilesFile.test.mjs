/*
 * Adding an account to profiles.json (server/profilesFile.js): the id it gets, the entry it writes,
 * and the care taken with the user's file. All on a tmpdir.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slugify, uniqueProfileId, addAccountProfile } from '../server/profilesFile.js';
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
