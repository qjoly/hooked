/*
 * Filtre d'affichage des modèles (src/lib/models.js) — fonction pure, testée sur la forme exacte
 * que produit server/capabilities.js (buildModelGroups). Le point à ne pas régresser : c'est une
 * liste NOIRE (un id inconnu, donc une version future, reste visible) et l'alias de famille comme
 * le modèle courant survivent toujours au filtre.
 */
import { describe, it, expect } from 'vitest';
import { filterModelGroups, isHideableModel, DEFAULT_HIDDEN_MODELS } from '../src/lib/models.js';

const GROUPS = [
  { label: 'Opus', opts: [['opus', 'Opus (default)'], ['claude-opus-5', '5'], ['claude-opus-4-8', '4.8'], ['claude-opus-4-5', '4.5']] },
  { label: 'Haiku', opts: [['haiku', 'Haiku (default)'], ['claude-haiku-4-5', '4.5'], ['claude-haiku-3-5', '3.5']] },
];
const ids = (groups) => groups.flatMap((g) => g.opts.map(([id]) => id));

describe('isHideableModel', () => {
  it('accepts concrete versions only — never a family alias', () => {
    expect(isHideableModel('claude-opus-4-5')).toBe(true);
    expect(isHideableModel('claude-fable-5')).toBe(true);
    expect(isHideableModel('opus')).toBe(false);
    expect(isHideableModel('claude-gpt-4-5')).toBe(false);
    expect(isHideableModel('claude-opus-4-5-20251101')).toBe(false); // snapshot daté
    expect(isHideableModel(null)).toBe(false);
  });
});

describe('filterModelGroups', () => {
  it('drops the hidden versions and keeps the rest', () => {
    const out = filterModelGroups(GROUPS, ['claude-opus-4-5', 'claude-haiku-3-5']);
    expect(ids(out)).toEqual(['opus', 'claude-opus-5', 'claude-opus-4-8', 'haiku', 'claude-haiku-4-5']);
  });

  it('never hides a family alias, even if listed', () => {
    expect(ids(filterModelGroups(GROUPS, ['opus', 'haiku']))).toEqual(ids(GROUPS));
  });

  it('keeps the currently selected model visible (a bound <select> must not lose its value)', () => {
    const out = filterModelGroups(GROUPS, ['claude-opus-4-5'], 'claude-opus-4-5');
    expect(ids(out)).toContain('claude-opus-4-5');
  });

  it('is a blacklist: an unknown (future) version stays visible', () => {
    const withNext = [{ label: 'Opus', opts: [['claude-opus-5-1', '5.1'], ['claude-opus-4-5', '4.5']] }];
    expect(ids(filterModelGroups(withNext, DEFAULT_HIDDEN_MODELS))).toEqual(['claude-opus-5-1']);
  });

  it('returns the list untouched when nothing is hidden', () => {
    expect(filterModelGroups(GROUPS, [])).toEqual(GROUPS);
    expect(filterModelGroups(GROUPS, null)).toEqual(GROUPS);
  });

  it('drops a group left empty and tolerates junk input', () => {
    const only = [{ label: 'Haiku', opts: [['claude-haiku-3-5', '3.5']] }];
    expect(filterModelGroups(only, ['claude-haiku-3-5'])).toEqual([]);
    expect(filterModelGroups(null, ['claude-opus-4-5'])).toEqual([]);
  });

  it('hides exactly the old generations by default', () => {
    const all = [
      { label: 'Opus', opts: [['opus', ''], ['claude-opus-5', ''], ['claude-opus-4-8', ''], ['claude-opus-4-7', ''], ['claude-opus-4-6', ''], ['claude-opus-4-5', ''], ['claude-opus-4-1', ''], ['claude-opus-4-0', '']] },
      { label: 'Sonnet', opts: [['sonnet', ''], ['claude-sonnet-5', ''], ['claude-sonnet-4-6', ''], ['claude-sonnet-4-5', ''], ['claude-sonnet-4-0', ''], ['claude-sonnet-3-7', '']] },
      { label: 'Haiku', opts: [['haiku', ''], ['claude-haiku-4-5', ''], ['claude-haiku-3-5', '']] },
      { label: 'Fable', opts: [['fable', ''], ['claude-fable-5-1', ''], ['claude-fable-5', '']] },
    ];
    expect(ids(filterModelGroups(all, DEFAULT_HIDDEN_MODELS))).toEqual([
      'opus', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
      'sonnet', 'claude-sonnet-5', 'claude-sonnet-4-6',
      'haiku', 'claude-haiku-4-5',
      'fable', 'claude-fable-5-1', 'claude-fable-5',
    ]);
  });
});
