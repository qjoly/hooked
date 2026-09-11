/*
 * Model & effort capabilities derived from the claude binary (server/capabilities.js).
 * We test the PURE parsers on fixtures (no binary needed):
 *   - parseEffortsFromHelp : extracts the `--effort` choices from `claude --help` output.
 *   - buildModelGroups     : groups a flat id list by family, alias first, versions newest-first.
 * The binary readers (fetchEfforts/fetchModelGroups) just wire resolveClaudeBin + these parsers.
 */
import { describe, it, expect } from 'vitest';
import { parseEffortsFromHelp, buildModelGroups } from '../server/capabilities.js';

// Real-shape `claude --help` fragment: `--effort` documents its choices in parentheses, wrapped
// across lines exactly as the CLI renders it.
const HELP = `
  --debug                               Enable debug mode
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session (e.g. 'opus')
`;

describe('parseEffortsFromHelp', () => {
  it('extracts the choices in order across wrapped lines', () => {
    expect(parseEffortsFromHelp(HELP)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
  it('handles a single-line rendering', () => {
    expect(parseEffortsFromHelp('  --effort <level>  Effort (low, high, max)')).toEqual(['low', 'high', 'max']);
  });
  it('tolerates pipe-separated choices', () => {
    expect(parseEffortsFromHelp('--effort <level> (low|high)')).toEqual(['low', 'high']);
  });
  it('drops non lowercase-alpha tokens (anti-injection)', () => {
    expect(parseEffortsFromHelp('--effort <x> (low, XHIGH, 4, a b, max)')).toEqual(['low', 'max']);
  });
  it('returns [] when --effort is absent or input empty', () => {
    expect(parseEffortsFromHelp('--model <m> (opus)')).toEqual([]);
    expect(parseEffortsFromHelp('')).toEqual([]);
    expect(parseEffortsFromHelp(null)).toEqual([]);
  });
});

describe('buildModelGroups', () => {
  it('groups by family (Opus→Sonnet→Haiku→Fable), alias first, versions newest-first', () => {
    const ids = [
      'opus', 'sonnet', 'haiku', 'fable',
      'claude-opus-4-8', 'claude-opus-4-5', 'claude-opus-4-7',
      'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5', 'claude-fable-5-1',
    ];
    expect(buildModelGroups(ids)).toEqual([
      { label: 'Opus', opts: [['opus', 'Opus (default)'], ['claude-opus-4-8', '4.8'], ['claude-opus-4-7', '4.7'], ['claude-opus-4-5', '4.5']] },
      { label: 'Sonnet', opts: [['sonnet', 'Sonnet (default)'], ['claude-sonnet-4-6', '4.6']] },
      { label: 'Haiku', opts: [['haiku', 'Haiku (default)'], ['claude-haiku-4-5', '4.5']] },
      { label: 'Fable', opts: [['fable', 'Fable (default)'], ['claude-fable-5-1', '5.1'], ['claude-fable-5', '5']] },
    ]);
  });
  it('keeps fable bare majors AND minors (its rolling ids), but still excludes dated snapshots', () => {
    const fable = buildModelGroups(['fable', 'claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-20260901'])[0];
    expect(fable.opts).toEqual([['fable', 'Fable (default)'], ['claude-fable-5-1', '5.1'], ['claude-fable-5', '5']]);
  });
  it('excludes bare-major ids <5 and dated snapshots', () => {
    const ids = ['opus', 'claude-opus-4', 'claude-opus-4-8', 'claude-opus-4-20250514', 'claude-opus-4-1-20250805'];
    expect(buildModelGroups(ids)[0].opts).toEqual([['opus', 'Opus (default)'], ['claude-opus-4-8', '4.8']]);
  });
  it('keeps the 5+ generation bare-major rolling id (claude-opus-5 dropped the minor, like fable)', () => {
    const ids = ['opus', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-5-20260101'];
    expect(buildModelGroups(ids)[0].opts).toEqual([
      ['opus', 'Opus (default)'], ['claude-opus-5', '5'], ['claude-opus-4-8', '4.8'],
    ]);
  });
  it('sorts versions numerically, not lexically (4.10 before 4.9)', () => {
    const opus = buildModelGroups(['opus', 'claude-opus-4-9', 'claude-opus-4-10'])[0];
    expect(opus.opts).toEqual([['opus', 'Opus (default)'], ['claude-opus-4-10', '4.10'], ['claude-opus-4-9', '4.9']]);
  });
  it('builds a group from versions even if the family alias is missing', () => {
    expect(buildModelGroups(['claude-haiku-4-5'])).toEqual([
      { label: 'Haiku', opts: [['claude-haiku-4-5', '4.5']] },
    ]);
  });
  it('omits families with no ids, and returns [] for an empty list', () => {
    expect(buildModelGroups(['opus']).map((g) => g.label)).toEqual(['Opus']);
    expect(buildModelGroups([])).toEqual([]);
    expect(buildModelGroups(null)).toEqual([]);
  });
});
