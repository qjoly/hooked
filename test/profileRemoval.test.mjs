/*
 * Removing a profile (server/profileRemoval.js, removeProfileEntry in server/profilesFile.js), the
 * sign-ins an abandoned panel leaves open (cancelLoginsOf in server/account.js) and the default
 * account setting. Side effects are injected: no CLI, no session.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeProfile } from '../server/profileRemoval.js';
import { removeProfileEntry } from '../server/profilesFile.js';
import { cancelLoginsOf, countLoginsInFlight } from '../server/account.js';
import { SETTINGS_DEFAULTS, sanitizeSettings } from '../server/settings.js';

const ACCOUNT = { id: 'lucca', kind: 'anthropic', configDir: '/data/accounts/lucca' };
const SERVER = { id: 'lm', kind: 'compatible', env: { ANTHROPIC_BASE_URL: 'http://x' } };

// Dependencies that record what happened, in order.
function deps(over = {}) {
  const calls = [];
  const d = {
    find: (id) => ({ lucca: ACCOUNT, lm: SERVER })[id] || null,
    liveSessionsOn: () => 0,
    cancelLogins: (id) => calls.push(['cancelLogins', id]),
    logout: async (id) => { calls.push(['logout', id]); return { ok: true, message: '' }; },
    removeEntry: (id) => { calls.push(['removeEntry', id]); return { removed: true }; },
    clearDefault: (id) => calls.push(['clearDefault', id]),
    ...over,
  };
  return { d, calls };
}

describe('removeProfile', () => {
  it('ends the sign-ins, signs the account out, removes the entry, then forgets it as the default', async () => {
    const { d, calls } = deps();
    const r = await removeProfile('lucca', d);
    expect(r).toEqual({ removed: true, loggedOut: true, keptDir: '/data/accounts/lucca' });
    expect(calls.map((c) => c[0])).toEqual(['cancelLogins', 'logout', 'removeEntry', 'clearDefault']);
  });

  it('keeps the account\'s directory, and says where', async () => {
    const r = await removeProfile('lucca', deps().d);
    expect(r.keptDir).toBe('/data/accounts/lucca');
  });

  it('has nothing to sign out for a server', async () => {
    const { d, calls } = deps();
    const r = await removeProfile('lm', d);
    expect(r).toEqual({ removed: true, loggedOut: null, keptDir: null });
    expect(calls.map((c) => c[0])).toEqual(['removeEntry', 'clearDefault']);
  });

  it('refuses while a session runs on it, touching nothing', async () => {
    const { d, calls } = deps({ liveSessionsOn: () => 2 });
    const r = await removeProfile('lucca', d);
    expect(r.error).toBe('2 sessions are running on it. Stop them first.');
    expect(calls).toEqual([]);
    expect((await removeProfile('lucca', deps({ liveSessionsOn: () => 1 }).d)).error).toBe('1 session is running on it. Stop it first.');
  });

  it('removes the entry all the same when the sign-out fails, and says so', async () => {
    for (const logout of [async () => ({ ok: false }), async () => { throw new Error('boom'); }]) {
      const { d, calls } = deps({ logout });
      const r = await removeProfile('lucca', d);
      expect(r.removed).toBe(true);
      expect(r.loggedOut).toBe(false);
      expect(calls.map((c) => c[0])).toContain('removeEntry');
    }
  });

  it('does not touch the default setting when the entry could not be removed', async () => {
    const { d, calls } = deps({ removeEntry: () => ({ error: 'profiles.json could not be written: EACCES' }) });
    const r = await removeProfile('lucca', d);
    expect(r.error).toMatch(/could not be written/);
    expect(calls.map((c) => c[0])).not.toContain('clearDefault');
  });

  it('refuses the main account, an unknown profile and a non-string id', async () => {
    const { d, calls } = deps();
    expect((await removeProfile('default', d)).error).toMatch(/main account cannot be removed/);
    expect((await removeProfile('', d)).error).toMatch(/main account cannot be removed/);
    expect((await removeProfile(undefined, d)).error).toMatch(/main account cannot be removed/);
    expect((await removeProfile('nope', d)).error).toBe('unknown profile');
    expect(calls).toEqual([]);
  });
});

describe('removeProfileEntry', () => {
  const setup = (content) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-removal-'));
    const file = path.join(dir, 'profiles.json');
    if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return { dir, file };
  };
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const OTHER = { id: 'other', kind: 'anthropic', futureKey: { keep: 'me' } };

  it('takes the entry out and writes the others back exactly as they were', () => {
    const { file } = setup([ACCOUNT, OTHER, { id: 'broken', kind: 'nope' }]);
    expect(removeProfileEntry('lucca', { file })).toEqual({ removed: true });
    expect(read(file)).toEqual([OTHER, { id: 'broken', kind: 'nope' }]);
  });

  it('leaves the file private', () => {
    const { file } = setup([ACCOUNT]);
    fs.chmodSync(file, 0o644);
    removeProfileEntry('lucca', { file });
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
  });

  it('refuses an id the file does not have, leaving it untouched', () => {
    const { file } = setup([ACCOUNT]);
    const before = fs.readFileSync(file, 'utf8');
    expect(removeProfileEntry('nope', { file }).error).toBe('unknown profile');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses the reserved id, a missing file and a file that is not an array, leaving them as they are', () => {
    expect(removeProfileEntry('default', { file: setup([ACCOUNT]).file }).error).toBe('unknown profile');
    expect(removeProfileEntry('lucca', { file: path.join(setup().dir, 'profiles.json') }).error).toBe('unknown profile');
    const bad = setup('{ nope');
    expect(removeProfileEntry('lucca', { file: bad.file }).error).toMatch(/left as it is/);
    expect(fs.readFileSync(bad.file, 'utf8')).toBe('{ nope');
  });

  it('leaves no temporary file behind', () => {
    const { dir, file } = setup([ACCOUNT, OTHER]);
    removeProfileEntry('lucca', { file });
    expect(fs.readdirSync(dir)).toEqual(['profiles.json']);
  });
});

describe('cancelLoginsOf — an abandoned sign-in', () => {
  const login = (key, done = false) => {
    const e = { key, done, killed: false, startedAt: Date.now(), timer: null };
    e.child = { kill() { e.killed = true; } };
    return e;
  };

  it('ends the open sign-ins of that account only', () => {
    const a1 = login('lucca'), a2 = login('lucca'), main = login('default'), finished = login('lucca', true);
    const reg = new Map([['1', a1], ['2', a2], ['3', main], ['4', finished]]);
    expect(cancelLoginsOf(reg, 'lucca')).toBe(2);
    expect([a1.killed, a2.killed, main.killed, finished.killed]).toEqual([true, true, false, false]);
    expect([a1.done, a2.done, main.done]).toEqual([true, true, false]);
  });

  it('frees the places they held, which is what locked "Switch" out', () => {
    const reg = new Map([['1', login('lucca')], ['2', login('lucca')]]);
    expect(countLoginsInFlight(reg)).toBe(2);
    cancelLoginsOf(reg, 'lucca');
    expect(countLoginsInFlight(reg)).toBe(0);
  });

  it('is zero when nothing is open for that account, and survives a process that is already gone', () => {
    expect(cancelLoginsOf(new Map([['1', login('default')]]), 'lucca')).toBe(0);
    const e = login('lucca');
    e.child = { kill() { throw new Error('ESRCH'); } };
    expect(cancelLoginsOf(new Map([['1', e]]), 'lucca')).toBe(1);
    expect(e.done).toBe(true);
  });
});

describe('the default account setting', () => {
  it('is the main account by default', () => {
    expect(SETTINGS_DEFAULTS.defaultProfile).toBe('');
    expect(sanitizeSettings({}).defaultProfile).toBe('');
  });

  it('keeps a profile id', () => {
    for (const id of ['lucca', 'perso-2', 'a_b', '0abc']) expect(sanitizeSettings({ defaultProfile: id }).defaultProfile).toBe(id);
  });

  it('reads anything else as the main account', () => {
    for (const v of ['', 'Lucca', 'a b', '-x', 'x'.repeat(33), '../etc', 5, null, {}, ['lucca']]) {
      expect(sanitizeSettings({ defaultProfile: v }).defaultProfile).toBe('');
    }
  });
});
