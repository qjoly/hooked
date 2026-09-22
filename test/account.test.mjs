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
import { mergeAccountInfo, readAccountFile } from '../server/account.js';

const STATUS = {
  loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
  email: 'larago@luccasoftware.com', orgId: 'org-1', orgName: 'Luccasoftware', subscriptionType: 'team',
};
const FILE_ACCOUNT = {
  displayName: 'Lilian', email: 'larago@luccasoftware.com', organizationName: 'Luccasoftware',
};

describe('mergeAccountInfo', () => {
  it('merges live status with the file cache, status winning where both carry a field', () => {
    expect(mergeAccountInfo(STATUS, FILE_ACCOUNT)).toEqual({
      loggedIn: true,
      email: 'larago@luccasoftware.com',
      displayName: 'Lilian',
      organizationName: 'Luccasoftware',
      subscriptionType: 'team',
    });
  });

  it('displayName only ever comes from the file — auth status does not carry it', () => {
    const noFile = mergeAccountInfo(STATUS, null);
    expect(noFile.displayName).toBe(null);
    expect(noFile.email).toBe('larago@luccasoftware.com'); // still available from status
  });

  it('falls back to the file when the CLI call failed (status = null)', () => {
    expect(mergeAccountInfo(null, FILE_ACCOUNT)).toEqual({
      loggedIn: null,
      email: 'larago@luccasoftware.com',
      displayName: 'Lilian',
      organizationName: 'Luccasoftware',
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
      oauthAccount: { displayName: 'Lilian', emailAddress: 'larago@luccasoftware.com', organizationName: 'Luccasoftware' },
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
