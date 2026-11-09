/*
 * The environment a web or desktop terminal's shell starts with.
 *
 * Regression: hooked runs under launchd, which sets no locale, so its shells had none and zsh
 * echoed every non-ASCII byte typed at the prompt as `<0097>`.
 */
import { describe, it, expect } from 'vitest';
import { ptyEnv } from '../server/terminal.js';

describe('ptyEnv', () => {
  it('gives a shell with no locale a UTF-8 one', () => {
    const env = ptyEnv({ PATH: '/bin' });
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');
    expect(env.PATH).toBe('/bin');
  });

  it('keeps a locale the user set', () => {
    expect(ptyEnv({ LANG: 'fr_FR.UTF-8' }).LANG).toBe('fr_FR.UTF-8');
    expect(ptyEnv({ LC_ALL: 'C' }).LANG).toBeUndefined();
    expect(ptyEnv({ LC_CTYPE: 'en_GB.UTF-8' }).LANG).toBeUndefined();
  });
});
