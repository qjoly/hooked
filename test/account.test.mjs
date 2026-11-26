/*
 * Claude account identity (server/account.js): the merge between `claude auth status --json`
 * (live) and `oauthAccount` in ~/.claude.json (displayName, the CLI's own cache). Both sources are
 * real-shape objects here, so mergeAccountInfo — the only pure part of the module — is tested
 * without spawning the CLI. readAccountFile just adds an mtime-cached JSON.parse of that file,
 * same pattern as server/utilization.js's readUtilization.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeAccountInfo, readAccountFile, accountScope, countLoginsInFlight, parseAuthStatus } from '../server/account.js';

const STATUS = {
  loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
  email: 'larago@example.com', orgId: 'org-1', orgName: 'Example Corp', subscriptionType: 'team',
};
const FILE_ACCOUNT = {
  displayName: 'Lilian', email: 'larago@example.com', organizationName: 'Example Corp',
};

describe('mergeAccountInfo', () => {
  it('merges live status with the file cache, status winning where both carry a field', () => {
    expect(mergeAccountInfo(STATUS, FILE_ACCOUNT)).toEqual({
      loggedIn: true,
      email: 'larago@example.com',
      displayName: 'Lilian',
      organizationName: 'Example Corp',
      subscriptionType: 'team',
    });
  });

  it('displayName only ever comes from the file — auth status does not carry it', () => {
    const noFile = mergeAccountInfo(STATUS, null);
    expect(noFile.displayName).toBe(null);
    expect(noFile.email).toBe('larago@example.com'); // still available from status
  });

  it('falls back to the file when the CLI call failed (status = null)', () => {
    expect(mergeAccountInfo(null, FILE_ACCOUNT)).toEqual({
      loggedIn: null,
      email: 'larago@example.com',
      displayName: 'Lilian',
      organizationName: 'Example Corp',
      subscriptionType: null,
    });
  });

  it('degrades to all-null when neither source has anything', () => {
    expect(mergeAccountInfo(null, null)).toEqual({
      loggedIn: null, email: null, displayName: null, organizationName: null, subscriptionType: null,
    });
  });
});

describe('readAccountFile', () => {
  it('returns null when the config file is absent', () => {
    expect(readAccountFile('/nonexistent/.claude.json')).toBe(null);
  });

  it('reads oauthAccount, mapping emailAddress -> email', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-account-'));
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({
      oauthAccount: { displayName: 'Lilian', emailAddress: 'larago@example.com', organizationName: 'Example Corp' },
    }));
    expect(readAccountFile(file)).toEqual(FILE_ACCOUNT);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null on malformed JSON or a missing oauthAccount key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-account-'));
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, 'not json');
    expect(readAccountFile(bad)).toBe(null);
    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, '{}');
    expect(readAccountFile(empty)).toBe(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('readAccountFile — several accounts', () => {
  it('keeps each account\'s identity apart, whatever the order they are read in', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-acct-'));
    const write = (name, email) => {
      const f = path.join(dir, name + '.claude.json');
      fs.writeFileSync(f, JSON.stringify({ oauthAccount: { emailAddress: email, displayName: name } }));
      return f;
    };
    const a = write('a', 'a@x'), b = write('b', 'b@x');
    expect(readAccountFile(a).email).toBe('a@x');
    expect(readAccountFile(b).email).toBe('b@x');
    expect(readAccountFile(a).email).toBe('a@x');
    expect(readAccountFile(b).email).toBe('b@x');
  });
});

describe('accountScope', () => {
  const BASE = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-shell', CLAUDE_CODE_OAUTH_TOKEN: 'tok-shell', CLAUDE_CONFIG_DIR: '/elsewhere' };
  const profile = { id: 'perso', kind: 'anthropic', env: {}, configDir: '/data/accounts/perso' };

  it('is the login environment itself for the default account', () => {
    const s = accountScope(null, BASE);
    expect(s.key).toBe('default');
    expect(s.profile).toBeNull();
    expect(s.env.ANTHROPIC_API_KEY).toBe('sk-shell');
    expect(s.env.CLAUDE_CONFIG_DIR).toBe('/elsewhere');
  });

  it('points a profile\'s account at its own directory and identity file', () => {
    const s = accountScope(profile, BASE);
    expect(s.key).toBe('perso');
    expect(s.env.CLAUDE_CONFIG_DIR).toBe('/data/accounts/perso');
    expect(s.file).toBe('/data/accounts/perso/.claude.json');
    expect(s.profile).toBe(profile);
  });

  it('drops the credentials of the login environment: they belong to another account', () => {
    const s = accountScope(profile, BASE);
    expect(s.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(s.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(s.env.PATH).toBe('/bin');
  });

  it('refuses a profile that has no account of its own', () => {
    expect(() => accountScope({ id: 'work', kind: 'anthropic', env: {} }, BASE)).toThrow(/no account of its own/);
  });
});

describe('countLoginsInFlight', () => {
  it('counts the logins that still hold a PTY, not the finished ones kept for polling', () => {
    const reg = new Map([['a', { done: true }], ['b', { done: false }], ['c', { done: true }], ['d', { done: false }]]);
    expect(countLoginsInFlight(reg)).toBe(2);
  });

  it('lets a new sign-in start after two were cancelled, which a plain size would not', () => {
    const reg = new Map([['a', { done: true }], ['b', { done: true }]]);
    expect(reg.size).toBeGreaterThanOrEqual(2);
    expect(countLoginsInFlight(reg)).toBe(0);
  });

  it('is zero for an empty registry', () => {
    expect(countLoginsInFlight(new Map())).toBe(0);
  });
});

describe('parseAuthStatus', () => {
  it('reads a signed-in status', () => {
    expect(parseAuthStatus(JSON.stringify(STATUS))).toEqual(STATUS);
  });

  it('reads the signed-out status the CLI prints before exiting with 1, as a plain false', () => {
    const out = '{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty"\n}\n';
    expect(parseAuthStatus(out)).toEqual({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });
    expect(mergeAccountInfo(parseAuthStatus(out), null).loggedIn).toBe(false);
  });

  it('is null for anything that is not a status: empty, partial, another shape', () => {
    for (const out of ['', '   ', '{ "loggedIn": tru', 'not json', '[]', '{}', '{"loggedIn":"yes"}', 'null', undefined]) {
      expect(parseAuthStatus(out)).toBeNull();
    }
    expect(mergeAccountInfo(parseAuthStatus(''), null).loggedIn).toBeNull();
  });
});
