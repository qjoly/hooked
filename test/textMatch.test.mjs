/*
 * textMatch — case/accent-insensitive matching behind the Settings search (filter + highlight).
 * The subtle part is offsets: `findTermRanges` searches a FOLDED copy of the text but must return
 * positions in the ORIGINAL string, whose length differs once accents are decomposed.
 */
import { describe, it, expect } from 'vitest';
import { fold, findTermRanges } from '../src/lib/textMatch.js';

describe('fold', () => {
  it('lowercases and strips diacritics, precomposed or decomposed', () => {
    expect(fold('Élan')).toBe('elan');
    expect(fold('élan')).toBe('elan');
    expect(fold('HAIKU')).toBe('haiku');
  });
});

describe('findTermRanges', () => {
  it('matches regardless of case, with offsets in the original string', () => {
    expect(findTermRanges('Show Sidebar', ['sidebar'])).toEqual([[5, 12]]);
  });

  it('matches regardless of accents, on either side', () => {
    expect(findTermRanges('Café', ['cafe'])).toEqual([[0, 4]]);
    expect(findTermRanges('cafe', ['café'])).toEqual([[0, 4]]);
  });

  it('keeps original offsets after a decomposed character shortened the folded text', () => {
    // "é" is two code units in the source but folds to a single "e".
    expect(findTermRanges('élan vital', ['vital'])).toEqual([[6, 11]]);
  });

  it('keeps a trailing combining mark inside the range so the whole glyph is painted', () => {
    expect(findTermRanges('café latte', ['cafe'])).toEqual([[0, 5]]);
  });

  it('finds every occurrence of every term, sorted by position', () => {
    expect(findTermRanges('git stash, git pull', ['git', 'pull'])).toEqual([[0, 3], [11, 14], [15, 19]]);
  });

  it('does not overlap occurrences of the same term', () => {
    expect(findTermRanges('aaa', ['aa'])).toEqual([[0, 2]]);
  });

  it('returns nothing for an absent term, an empty term list or an empty text', () => {
    expect(findTermRanges('Appearance', ['stash'])).toEqual([]);
    expect(findTermRanges('Appearance', [])).toEqual([]);
    expect(findTermRanges('Appearance', ['', '  '])).toEqual([]);
    expect(findTermRanges('', ['a'])).toEqual([]);
  });

  it('handles astral characters without shifting later offsets', () => {
    expect(findTermRanges('🚀 Launch', ['launch'])).toEqual([[3, 9]]);
  });
});
