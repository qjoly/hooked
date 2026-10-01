/*
 * Claude account identity (server/account.js): the merge between `claude auth status --json`
 * (live) and `oauthAccount` in ~/.claude.json (displayName, the CLI's own cache). Both sources are
 * real-shape objects here, so mergeAccountInfo — the only pure part of the module — is tested
 * without spawning the CLI. readAccountFile just adds an mtime-cached JSON.parse of that file,
 * same pattern as server/utilization.js's readUtilization.
 *
 * The PTY login flow itself (startAccountLogin) is NOT covered here, same reasoning as mcp.js's
 * login flow: no precedent in this repo for mocking node-pty, and a real CLI spawn doesn't belong
 * in `npm test`. What IS covered: `snapshot`/`finish`, the pure state-transition helpers around a
 * fake `entry` object (no real PTY needed), and the roster's file-based read/write/merge helpers,
 * every one of which takes its file/dir/platform as an injectable argument precisely so tests can
 * point them at a tmpdir instead of the real ~/.claude/hooked.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mergeAccountInfo, readAccountFile, snapshot, finish, markRosterActive,
  readRoster, writeRoster, readActiveCredentialsRaw, writeActiveCredentialsRaw,
  writeSecret, readSecret, deleteSecret,
} from '../server/account.js';

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

describe('snapshot / finish (PTY login state, no real PTY needed)', () => {
  const fakeEntry = () => ({ id: 'abc', url: null, done: false, exitCode: null, reason: null, startedAt: 1000, buf: '' });

  it('snapshot reflects an in-progress entry', () => {
    const e = { ...fakeEntry(), url: 'https://example.com/auth', buf: 'waiting for code...' };
    const s = snapshot(e);
    expect(s).toMatchObject({ id: 'abc', url: 'https://example.com/auth', done: false, exitCode: null, reason: null, startedAt: 1000 });
    expect(s.needsPaste).toBe(false);
  });

  it('finish() is a no-op once already done — the first outcome wins', () => {
    const e = fakeEntry();
    finish(e, 0);
    finish(e, -1, 'cancelled'); // must not override the successful completion
    expect(e.exitCode).toBe(0);
    expect(e.reason).toBe(null);
  });

  it('a successful finish always clears reason, even if one was passed', () => {
    const e = fakeEntry();
    finish(e, 0, 'exited');
    expect(snapshot(e)).toMatchObject({ done: true, exitCode: 0, reason: null });
  });

  it('distinguishes a timeout from a user cancel — both exit at code -1', () => {
    const timedOut = fakeEntry();
    finish(timedOut, -1, 'timeout');
    expect(snapshot(timedOut).reason).toBe('timeout');

    const cancelled = fakeEntry();
    finish(cancelled, -1, 'cancelled');
    expect(snapshot(cancelled).reason).toBe('cancelled');
  });
});

describe('markRosterActive', () => {
  const roster = [
    { id: '1', email: 'a@x.com', label: 'Work' },
    { id: '2', email: 'b@x.com', label: 'Personal' },
  ];

  it('flags the entry whose email matches the currently signed-in one', () => {
    expect(markRosterActive(roster, 'b@x.com')).toEqual([
      { id: '1', email: 'a@x.com', label: 'Work', active: false },
      { id: '2', email: 'b@x.com', label: 'Personal', active: true },
    ]);
  });

  it('flags nothing when no email matches, or none is signed in', () => {
    expect(markRosterActive(roster, 'nobody@x.com').every((a) => !a.active)).toBe(true);
    expect(markRosterActive(roster, null).every((a) => !a.active)).toBe(true);
  });
});

describe('roster storage (file-based, tmpdir-injected)', () => {
  function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-roster-')); }

  it('round-trips accounts.json', () => {
    const dir = tmp();
    const file = path.join(dir, 'accounts.json');
    expect(readRoster(file)).toEqual([]); // absent file → empty roster, not a throw
    const accounts = [{ id: '1', label: 'Work', email: 'a@x.com', platform: 'file' }];
    writeRoster(accounts, file);
    expect(readRoster(file)).toEqual(accounts);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] on malformed JSON instead of throwing', () => {
    const dir = tmp();
    const file = path.join(dir, 'accounts.json');
    fs.writeFileSync(file, 'not json');
    expect(readRoster(file)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a saved secret on the file platform and deletes cleanly', () => {
    const dir = tmp();
    const platform = writeSecret('acct-1', '{"claudeAiOauth":{"accessToken":"tok"}}', dir, 'linux');
    expect(platform).toBe('file');
    expect(readSecret('acct-1', 'file', dir)).toBe('{"claudeAiOauth":{"accessToken":"tok"}}');
    deleteSecret('acct-1', 'file', dir);
    expect(readSecret('acct-1', 'file', dir)).toBe(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reading a never-saved secret returns null, not a throw', () => {
    const dir = tmp();
    expect(readSecret('nope', 'file', dir)).toBe(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('active credentials raw read/write (file platform, tmpdir-injected)', () => {
  it('reads back exactly what was written, byte for byte', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-creds-'));
    const file = path.join(dir, '.credentials.json');
    const raw = '{"claudeAiOauth":{"accessToken":"tok-123","expiresAt":9999999999999}}';
    writeActiveCredentialsRaw(raw, file, 'linux');
    expect(readActiveCredentialsRaw(file, 'linux')).toBe(raw);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when nothing has been written and there is no keychain to fall back to', () => {
    expect(readActiveCredentialsRaw('/nonexistent/.credentials.json', 'linux')).toBe(null);
  });
});
