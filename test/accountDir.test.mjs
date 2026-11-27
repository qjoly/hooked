/*
 * The directory of a profile's own account (server/accountDir.js): created private, with the parts
 * that are not about identity linked to the default account's, and never anything replaced.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareAccountDir, SHARED_ENTRIES } from '../server/accountDir.js';

// A default account dir with some of the shared entries, and an account dir path that does not exist yet.
function setup(entries = ['projects', 'settings.json', 'CLAUDE.md', 'skills', 'commands']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-acctdir-'));
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  for (const e of entries) {
    const p = path.join(main, e);
    if (/\.(json|md)$/.test(e)) fs.writeFileSync(p, e === 'settings.json' ? '{"hooks":{}}' : '# rules');
    else fs.mkdirSync(p);
  }
  const dir = path.join(root, 'accounts', 'perso');
  return { root, main, dir, profile: { id: 'perso', kind: 'anthropic', configDir: dir } };
}
const isLink = (p) => fs.lstatSync(p).isSymbolicLink();

describe('prepareAccountDir', () => {
  it('creates the directory, private, with the shared entries linked to the default account\'s', () => {
    const { main, dir, profile } = setup();
    const r = prepareAccountDir(profile, { mainDir: main });
    expect(r.error).toBeUndefined();
    expect(r.dir).toBe(dir);
    expect(r.linked.sort()).toEqual(['CLAUDE.md', 'commands', 'projects', 'settings.json', 'skills']);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    for (const name of r.linked) {
      expect(isLink(path.join(dir, name))).toBe(true);
      expect(fs.readlinkSync(path.join(dir, name))).toBe(path.join(main, name));
    }
  });

  it('tightens a directory that already exists with looser permissions, as the CLI leaves it', () => {
    const { main, dir, profile } = setup();
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
    prepareAccountDir(profile, { mainDir: main });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('reports what the default account has none of, and links nothing for it', () => {
    const { main, dir, profile } = setup(['projects', 'settings.json']);
    const r = prepareAccountDir(profile, { mainDir: main });
    expect(r.missing.sort()).toEqual(['CLAUDE.md', 'agents', 'commands', 'plugins', 'skills']);
    expect(fs.existsSync(path.join(dir, 'skills'))).toBe(false);
    expect(fs.lstatSync(path.join(dir, 'skills'), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('never links the identity or the login', () => {
    const { main, dir, profile } = setup();
    fs.writeFileSync(path.join(main, '.claude.json'), '{"oauthAccount":{"emailAddress":"main@x"}}');
    fs.writeFileSync(path.join(main, '.credentials.json'), '{"claudeAiOauth":{}}');
    prepareAccountDir(profile, { mainDir: main });
    expect(fs.existsSync(path.join(dir, '.claude.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.credentials.json'))).toBe(false);
    expect(SHARED_ENTRIES).not.toContain('.claude.json');
    expect(SHARED_ENTRIES).not.toContain('.credentials.json');
  });

  it('creates the default account\'s projects dir when it is missing: transcripts need somewhere to land', () => {
    const { main, dir, profile } = setup([]);
    const r = prepareAccountDir(profile, { mainDir: main });
    expect(r.linked).toContain('projects');
    expect(fs.statSync(path.join(main, 'projects')).isDirectory()).toBe(true);
    expect(fs.readlinkSync(path.join(dir, 'projects'))).toBe(path.join(main, 'projects'));
  });

  it('is idempotent', () => {
    const { main, profile } = setup();
    const first = prepareAccountDir(profile, { mainDir: main });
    const second = prepareAccountDir(profile, { mainDir: main });
    expect(second).toEqual(first);
  });

  it('leaves alone what is already in the account dir, a file, a directory or another link', () => {
    const { main, dir, profile, root } = setup();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"own":true}');
    fs.mkdirSync(path.join(dir, 'skills'));
    fs.writeFileSync(path.join(dir, 'skills', 'mine.md'), 'mine');
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(dir, 'commands'));
    const r = prepareAccountDir(profile, { mainDir: main });
    expect(r.kept.sort()).toEqual(['commands', 'settings.json', 'skills']);
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe('{"own":true}');
    expect(fs.readFileSync(path.join(dir, 'skills', 'mine.md'), 'utf8')).toBe('mine');
    expect(fs.readlinkSync(path.join(dir, 'commands'))).toBe(path.join(root, 'elsewhere'));
  });

  it('lets a transcript written through the account dir land in the default account\'s projects', () => {
    const { main, dir, profile } = setup();
    prepareAccountDir(profile, { mainDir: main });
    fs.mkdirSync(path.join(dir, 'projects', '-tmp-x'));
    fs.writeFileSync(path.join(dir, 'projects', '-tmp-x', 'abc.jsonl'), '{}\n');
    expect(fs.readFileSync(path.join(main, 'projects', '-tmp-x', 'abc.jsonl'), 'utf8')).toBe('{}\n');
  });

  it('refuses the default account\'s own directory, and a profile with no configDir', () => {
    const { main, profile } = setup();
    expect(prepareAccountDir({ ...profile, configDir: main }, { mainDir: main }).error).toMatch(/refusing/);
    expect(prepareAccountDir({ id: 'x', kind: 'anthropic' }, { mainDir: main }).error).toMatch(/no configDir/);
    expect(prepareAccountDir(null, { mainDir: main }).error).toMatch(/no configDir/);
  });

  it('answers with an error, not a throw, when the directory cannot be created', () => {
    const { main, root } = setup();
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'a file');
    const r = prepareAccountDir({ id: 'x', kind: 'anthropic', configDir: path.join(blocker, 'sub') }, { mainDir: main });
    expect(r.error).toMatch(/cannot prepare/);
    expect(r.error).toContain(path.join(blocker, 'sub'));
  });
});
