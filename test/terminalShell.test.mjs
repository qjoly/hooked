/*
 * Which shell a web terminal opens, and with which arguments.
 *
 * Regression: the shell was `process.env.SHELL || '/bin/zsh'`. On macOS SHELL is always set, so
 * the fallback never showed. On Windows started from PowerShell it is unset, node-pty was handed
 * `/bin/zsh` and answered `File not found:` — an error naming no file, on a platform the
 * maintainer does not run. The `-l -i` arguments had the same shape of bug: POSIX-only flags
 * passed to whatever shell was picked.
 *
 * Platform and env are injected so the Windows behaviour is exercised from macOS too — the whole
 * point being that nobody notices these on their own machine.
 */
import { describe, it, expect } from 'vitest';
import { defaultShell, shellArgs } from '../server/terminal.js';

// A path guaranteed to exist on every platform, to stand in for "SHELL points at a real file".
const REAL_FILE = process.execPath;
const MISSING = '/nonexistent/definitely-not-a-shell';

describe('defaultShell — POSIX', () => {
  it('honours SHELL', () => {
    expect(defaultShell('darwin', { SHELL: '/bin/fish' })).toBe('/bin/fish');
    expect(defaultShell('linux', { SHELL: '/usr/bin/bash' })).toBe('/usr/bin/bash');
  });

  it('falls back to zsh when SHELL is unset', () => {
    expect(defaultShell('darwin', {})).toBe('/bin/zsh');
  });
});

describe('defaultShell — Windows', () => {
  it('never falls back to a POSIX path', () => {
    // The whole bug in one assertion.
    expect(defaultShell('win32', {})).not.toBe('/bin/zsh');
    expect(defaultShell('win32', {})).not.toMatch(/^\//);
  });

  it('honours SHELL when it names a file that exists (e.g. Git Bash)', () => {
    expect(defaultShell('win32', { SHELL: REAL_FILE })).toBe(REAL_FILE);
  });

  it('ignores a SHELL that does not resolve, rather than handing it to the PTY', () => {
    // Git Bash exports MSYS paths such as /usr/bin/bash, which CreateProcess cannot open.
    const picked = defaultShell('win32', { SHELL: MISSING, COMSPEC: 'C:\\Windows\\system32\\cmd.exe' });
    expect(picked).not.toBe(MISSING);
  });

  it('uses COMSPEC as the last resort', () => {
    const picked = defaultShell('win32', { SHELL: MISSING, PATH: '', COMSPEC: 'C:\\Windows\\system32\\cmd.exe' });
    expect(picked).toBe('C:\\Windows\\system32\\cmd.exe');
  });

  it('still yields something runnable with an empty environment', () => {
    expect(defaultShell('win32', { PATH: '' })).toBe('cmd.exe');
  });
});

describe('shellArgs — keyed on the shell, not the platform', () => {
  it('gives a POSIX shell its login/interactive flags', () => {
    for (const s of ['/bin/zsh', '/bin/bash', '/usr/bin/fish', '/bin/sh']) {
      expect(shellArgs(s)).toEqual(['-l', '-i']);
    }
  });

  it('keeps those flags for Git Bash on Windows', () => {
    expect(shellArgs('C:\\Program Files\\Git\\usr\\bin\\bash.exe')).toEqual(['-l', '-i']);
  });

  it('passes only -NoLogo to PowerShell', () => {
    expect(shellArgs('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toEqual(['-NoLogo']);
    expect(shellArgs('pwsh.exe')).toEqual(['-NoLogo']);
  });

  it('passes nothing to cmd, which would run -l as a command', () => {
    expect(shellArgs('C:\\Windows\\system32\\cmd.exe')).toEqual([]);
  });
});
