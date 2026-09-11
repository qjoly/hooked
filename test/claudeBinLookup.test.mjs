/*
 * Where the claude binary is looked for.
 *
 * Regression: resolution went through `command -v claude`, a POSIX shell builtin, and fell back to
 * a list of extensionless POSIX paths. On Windows both miss — the binary is `claude.exe` — so
 * resolveClaudeBin() returned null. Nothing crashed: capabilities are derived from that binary, so
 * the effort and model lists came back EMPTY, and the dashboard rejected every value with
 * `unknown effort: high` while offering no models at all. A missing binary and a binary with the
 * wrong extension were indistinguishable.
 *
 * Platform is injected so the Windows list is asserted from macOS too.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { claudeCandidates } from '../server/commands.js';
import { parseEffortsFromHelp } from '../server/capabilities.js';

describe('claudeCandidates — Windows', () => {
  const win = claudeCandidates('win32');

  it('never probes an extensionless name', () => {
    // The heart of the bug: `claude` does not exist on Windows, `claude.exe` does.
    for (const c of win) expect(path.extname(c)).not.toBe('');
  });

  it('only offers executable extensions', () => {
    for (const c of win) expect(path.extname(c).toLowerCase()).toMatch(/^\.(exe|cmd|bat)$/);
  });

  it('covers the npm global install, which ships a .cmd shim', () => {
    expect(win.some((c) => c.toLowerCase().endsWith('claude.cmd'))).toBe(true);
  });

  it('is not empty', () => {
    expect(win.length).toBeGreaterThan(0);
  });
});

describe('claudeCandidates — POSIX', () => {
  const posix = claudeCandidates('darwin');

  it('keeps the extensionless paths where they are correct', () => {
    for (const c of posix) expect(path.extname(c)).toBe('');
    expect(posix).toContain('/opt/homebrew/bin/claude');
  });

  it('differs from the Windows list', () => {
    expect(posix).not.toEqual(claudeCandidates('win32'));
  });
});

describe('parseEffortsFromHelp — what the empty list cost', () => {
  it('reads the levels claude documents', () => {
    const help = '  --effort <level>   Effort level for the current session (low, medium, high, xhigh, max)\n';
    expect(parseEffortsFromHelp(help)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('returns nothing it cannot parse, rather than guessing', () => {
    expect(parseEffortsFromHelp('')).toEqual([]);
    expect(parseEffortsFromHelp('no effort option here')).toEqual([]);
  });
});
