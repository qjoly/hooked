/*
 * Persistent hooked settings (server/settings.js) — sanitize round-trips through writeSettings /
 * readSettings on a throwaway HOOKED_DATA_DIR. Focus on quickLaunchProject: the default cwd used
 * when a session is launched without a folder (macOS Quick Action posting only a prompt).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'hooked-settings-test-' + process.pid);
process.env.HOOKED_DATA_DIR = TMP;

let readSettings, writeSettings;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  ({ readSettings, writeSettings } = await import('../server/settings.js'));
});

describe('quickLaunchProject', () => {
  it('defaults to empty (no default project)', () => {
    expect(readSettings().quickLaunchProject).toBe('');
  });

  it('keeps an absolute path', () => {
    const s = writeSettings({ quickLaunchProject: '/Users/x/proj' });
    expect(s.quickLaunchProject).toBe('/Users/x/proj');
    expect(readSettings().quickLaunchProject).toBe('/Users/x/proj');
  });

  it('rejects a relative path (falls back to empty)', () => {
    expect(writeSettings({ quickLaunchProject: 'relative/dir' }).quickLaunchProject).toBe('');
    expect(writeSettings({ quickLaunchProject: 42 }).quickLaunchProject).toBe('');
  });
});

describe('shipDefaultView', () => {
  it("defaults to 'claude'", () => {
    expect(readSettings().shipDefaultView).toBe('claude');
  });

  it("accepts 'vcs' and round-trips it", () => {
    expect(writeSettings({ shipDefaultView: 'vcs' }).shipDefaultView).toBe('vcs');
    expect(readSettings().shipDefaultView).toBe('vcs');
  });

  it("falls back to 'claude' on any unknown value", () => {
    expect(writeSettings({ shipDefaultView: 'git' }).shipDefaultView).toBe('claude');
    expect(writeSettings({ shipDefaultView: 42 }).shipDefaultView).toBe('claude');
  });
});

describe('remoteControlProjects', () => {
  it('defaults to an empty list', () => {
    expect(readSettings().remoteControlProjects).toEqual([]);
  });

  it('keeps absolute paths, deduped', () => {
    const s = writeSettings({ remoteControlProjects: ['/a/proj', '/b/proj', '/a/proj'] });
    expect(s.remoteControlProjects).toEqual(['/a/proj', '/b/proj']);
    expect(readSettings().remoteControlProjects).toEqual(['/a/proj', '/b/proj']);
  });

  it('drops relative paths and non-strings', () => {
    expect(writeSettings({ remoteControlProjects: ['rel/dir', 42, null, '/ok'] }).remoteControlProjects)
      .toEqual(['/ok']);
    expect(writeSettings({ remoteControlProjects: 'not-an-array' }).remoteControlProjects).toEqual([]);
  });

  it('caps the list at 32 entries', () => {
    const many = Array.from({ length: 40 }, (_, i) => `/p/${i}`);
    expect(writeSettings({ remoteControlProjects: many }).remoteControlProjects.length).toBe(32);
  });
});

describe('favoriteProjects', () => {
  it('defaults to an empty list', () => {
    expect(readSettings().favoriteProjects).toEqual([]);
  });

  it('keeps absolute paths, deduped', () => {
    const s = writeSettings({ favoriteProjects: ['/a/proj', '/b/proj', '/a/proj'] });
    expect(s.favoriteProjects).toEqual(['/a/proj', '/b/proj']);
    expect(readSettings().favoriteProjects).toEqual(['/a/proj', '/b/proj']);
  });

  it('drops relative paths and non-strings', () => {
    expect(writeSettings({ favoriteProjects: ['rel/dir', 42, null, '/ok'] }).favoriteProjects)
      .toEqual(['/ok']);
    expect(writeSettings({ favoriteProjects: 'not-an-array' }).favoriteProjects).toEqual([]);
  });

  it('caps the list at 64 entries', () => {
    const many = Array.from({ length: 80 }, (_, i) => `/p/${i}`);
    expect(writeSettings({ favoriteProjects: many }).favoriteProjects.length).toBe(64);
  });
});

describe('digest', () => {
  it('defaults to { auto:true, hour:7, model:"" }', () => {
    expect(readSettings().digest).toEqual({ auto: true, hour: 7, model: '' });
  });

  it('persists auto/hour and a valid model alias', () => {
    const s = writeSettings({ digest: { auto: false, hour: 9, model: 'sonnet' } });
    expect(s.digest).toEqual({ auto: false, hour: 9, model: 'sonnet' });
    expect(readSettings().digest).toEqual({ auto: false, hour: 9, model: 'sonnet' });
  });

  it('clamps an out-of-range hour and rejects an unknown model', () => {
    const s = writeSettings({ digest: { auto: true, hour: 99, model: 'bogus' } });
    expect(s.digest.hour).toBe(7);
    expect(s.digest.model).toBe('');
  });
});
