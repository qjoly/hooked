/*
 * The account gauges (5 h / 7 d / model-scoped) of several accounts at once: the token of each, the
 * Keychain item it lives in, the payload and back-off of each, and which statusline snapshot counts
 * for which account. Before, the freshest snapshot of ANY session and the one default account's
 * token fed every gauge, so two accounts would have taken turns on them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accessToken, keychainServiceFor } from '../server/oauth.js';
import { currentUtilization, usageFreshness, fetchUsage, accountLimit, accountOf, DEFAULT_ACCOUNT } from '../server/utilization.js';
import { accountRateLimits, sessionStatus } from '../server/status.js';
import { buildSnapshot } from '../server/agent-status.js';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-gauges-' + prefix));
const NOW = Date.parse('2026-11-26T12:00:00Z');
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// An account dir with a login (a .credentials.json) and, optionally, the CLI's cached usage.
function account(token, { cachedPct, expiresAt } = {}) {
  const dir = tmp('acct-');
  if (token) fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, ...(expiresAt ? { expiresAt } : {}) } }));
  if (cachedPct != null) {
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
      cachedUsageUtilization: { fetchedAtMs: NOW, utilization: { limits: [{ kind: 'session', percent: cachedPct, resets_at: '2026-11-26T15:00:00Z' }] } },
    }));
  }
  return dir;
}

describe('keychainServiceFor', () => {
  // The two dirs below were signed in on a real Mac, and the Keychain items found were named with
  // exactly these hashes: they are measured values, not computed ones.
  it('names the item after the first 8 hex of the sha256 of the dir path, as the CLI does', () => {
    expect(keychainServiceFor('/Users/larago/.claude-test-a', '/Users/larago')).toBe('Claude Code-credentials-242fcef7');
    expect(keychainServiceFor('/Users/larago/.claude-test-b', '/Users/larago')).toBe('Claude Code-credentials-3f642434');
  });

  it('keeps the bare name for ~/.claude itself', () => {
    expect(keychainServiceFor('/Users/larago/.claude', '/Users/larago')).toBe('Claude Code-credentials');
    expect(keychainServiceFor('~/.claude/', '/Users/larago')).toBe('Claude Code-credentials');
  });

  it('hashes the normalized path: `~/` expanded, no trailing slash', () => {
    const want = 'Claude Code-credentials-242fcef7';
    expect(keychainServiceFor('~/.claude-test-a', '/Users/larago')).toBe(want);
    expect(keychainServiceFor('/Users/larago/.claude-test-a/', '/Users/larago')).toBe(want);
  });

  it('gives two dirs two different items', () => {
    expect(keychainServiceFor('/a/one', '/h')).not.toBe(keychainServiceFor('/a/two', '/h'));
  });

  it('falls back to the bare name for something that is not a path', () => {
    expect(keychainServiceFor(null, '/h')).toBe('Claude Code-credentials');
  });
});

describe('accessToken — one per account', () => {
  it('reads each account\'s own token from its own dir, never the other\'s', () => {
    const a = account('tok-A'), b = account('tok-B');
    expect(accessToken(NOW, a)).toBe('tok-A');
    expect(accessToken(NOW, b)).toBe('tok-B');
    expect(accessToken(NOW + 1, a)).toBe('tok-A');
  });

  it('has none for an account that is not signed in', () => {
    expect(accessToken(NOW, account(null))).toBeNull();
  });

  it('has none for an expired token: the CLI refreshes it on its next call', () => {
    expect(accessToken(NOW, account('tok-old', { expiresAt: NOW - 1000 }))).toBeNull();
    expect(accessToken(NOW, account('tok-new', { expiresAt: NOW + 3_600_000 }))).toBe('tok-new');
  });

  it('is not overridden by HOOKED_OAUTH_TOKEN, which stands for the default account only', () => {
    const prev = process.env.HOOKED_OAUTH_TOKEN;
    process.env.HOOKED_OAUTH_TOKEN = 'override';
    try {
      expect(accessToken(NOW, account('tok-A'))).toBe('tok-A');
      expect(accessToken(NOW, account(null))).toBeNull();
      expect(accessToken(NOW)).toBe('override');
    } finally { if (prev === undefined) delete process.env.HOOKED_OAUTH_TOKEN; else process.env.HOOKED_OAUTH_TOKEN = prev; }
  });
});

describe('utilization — one per account', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const acct = (dir, id) => accountOf({ id, configDir: dir });

  it('reads each account\'s cached usage from its own .claude.json', () => {
    const a = acct(account('t', { cachedPct: 11 }), 'a'), b = acct(account('t', { cachedPct: 42 }), 'b');
    expect(accountLimit('session', currentUtilization(NOW, a), NOW).pct).toBe(11);
    expect(accountLimit('session', currentUtilization(NOW, b), NOW).pct).toBe(42);
    expect(accountLimit('session', currentUtilization(NOW, a), NOW).pct).toBe(11);
  });

  it('polls an account with its own token, not another\'s', async () => {
    const seen = [];
    vi.stubGlobal('fetch', async (url, init) => {
      seen.push(init.headers.Authorization);
      return { ok: true, json: async () => ({ limits: [{ kind: 'session', percent: 7, resets_at: '2026-11-26T15:00:00Z' }] }) };
    });
    const util = await fetchUsage(acct(account('tok-A'), 'a'));
    expect(seen).toEqual(['Bearer tok-A']);
    expect(accountLimit('session', util, NOW).pct).toBe(7);
  });

  it('refuses to poll an account with no token of its own, whatever the default account has', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('must not be called'); });
    await expect(fetchUsage(acct(account(null), 'nobody'))).rejects.toThrow(/no usable local OAuth token/);
  });

  it('keeps each account\'s live answer and back-off apart', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ limits: [{ kind: 'session', percent: 7, resets_at: '2026-11-26T15:00:00Z' }] }) }));
    const signedIn = acct(account('tok-ok'), 'signed-in'), signedOut = acct(account(null), 'signed-out');
    const later = Date.now() + 10;
    currentUtilization(Date.now(), signedIn);
    currentUtilization(Date.now(), signedOut);
    await wait();
    const ok = usageFreshness(later, signedIn), ko = usageFreshness(later, signedOut);
    expect(ok.source).toBe('live');
    expect(ok.error).toBeNull();
    expect(ko.source).toBeNull();
    expect(ko.error).toMatch(/no usable local OAuth token/);
  });

  it('keeps the default account apart from any profile\'s', () => {
    expect(DEFAULT_ACCOUNT.key).toBe('default');
    expect(accountOf(null)).toBe(DEFAULT_ACCOUNT);
    expect(accountOf({ id: 'token-only', configDir: undefined })).toBe(DEFAULT_ACCOUNT);
    expect(accountOf({ id: 'perso', configDir: '/d/perso' })).toEqual({ key: 'perso', configDir: '/d/perso' });
  });
});

describe('statusline snapshots — one account at a time', () => {
  // A status dir with snapshots; `age` decides which is the freshest.
  function statusDir(snaps) {
    const dir = tmp('status-');
    snaps.forEach(({ id, profile, five, age }) => {
      const f = path.join(dir, id + '.json');
      fs.writeFileSync(f, JSON.stringify({ session_id: id, ...(profile ? { profile } : {}), rate_limits: { five_hour: { used_percentage: five, resets_at: 1795730000 } } }));
      const t = new Date(NOW - age * 1000);
      fs.utimesSync(f, t, t);
    });
    return dir;
  }
  const SNAPS = [
    { id: 's-default', five: 10, age: 5 },                   // the freshest of all
    { id: 's-perso-new', profile: 'perso', five: 50, age: 60 },
    { id: 's-perso-old', profile: 'perso', five: 60, age: 600 },
    { id: 's-work', profile: 'work', five: 80, age: 30 },
  ];

  it('takes the freshest snapshot OF THE ACCOUNT asked for, not the freshest of all', () => {
    const dir = statusDir(SNAPS);
    expect(accountRateLimits(undefined, dir, NOW).fiveHour.pct).toBe(10);
    expect(accountRateLimits(undefined, dir, NOW, 'perso').fiveHour.pct).toBe(50);
    expect(accountRateLimits(undefined, dir, NOW, 'work').fiveHour.pct).toBe(80);
  });

  it('counts a snapshot with no profile, or the profile "default", as the default account\'s', () => {
    const dir = statusDir(SNAPS);
    expect(accountRateLimits(undefined, dir, NOW, null).fiveHour.pct).toBe(10);
    expect(accountRateLimits(undefined, dir, NOW, 'default').fiveHour.pct).toBe(10);
  });

  it('has none for an account that has not reported', () => {
    expect(accountRateLimits(undefined, statusDir(SNAPS), NOW, 'nobody')).toBeNull();
  });

  it('uses the asked-for session as a starting point only when it is of that account', () => {
    const dir = statusDir(SNAPS);
    // As before, a fresher snapshot of the same account still wins over the one asked for.
    expect(accountRateLimits('s-perso-old', dir, NOW, 'perso').fiveHour.pct).toBe(50);
    expect(accountRateLimits('s-perso-new', dir, NOW, 'perso').fiveHour.pct).toBe(50);
    // A session of another account must not stand in for this one, however it is asked for.
    expect(accountRateLimits('s-perso-old', dir, NOW, null).fiveHour.pct).toBe(10);
    expect(accountRateLimits('s-default', dir, NOW, 'perso').fiveHour.pct).toBe(50);
  });

  it('gives a session the rate limits of its own account in its status', () => {
    const dir = statusDir(SNAPS);
    expect(sessionStatus('s-perso-new', dir, NOW).rateLimit.fiveHour.pct).toBe(50);
    expect(sessionStatus('s-default', dir, NOW).rateLimit.fiveHour.pct).toBe(10);
    expect(sessionStatus('s-work', dir, NOW).rateLimit.fiveHour.pct).toBe(80);
  });
});

describe('buildSnapshot — which account', () => {
  const usage = { rate_limits_available: true, rate_limits: { five_hour: { utilization: 12, resets_at: '2026-11-26T15:00:00Z' } } };

  it('tags the snapshot with the profile of a session on one', () => {
    expect(buildSnapshot('s1', { usage, profile: 'perso' }, NOW).profile).toBe('perso');
  });

  it('leaves the default account untagged', () => {
    expect(buildSnapshot('s1', { usage }, NOW)).not.toHaveProperty('profile');
    expect(buildSnapshot('s1', { usage, profile: 'default' }, NOW)).not.toHaveProperty('profile');
    expect(buildSnapshot('s1', { usage, profile: null }, NOW)).not.toHaveProperty('profile');
  });
});
