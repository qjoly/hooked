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
