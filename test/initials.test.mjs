/*
 * Top bar avatar initials (src/lib/format.js). `oauthAccount.displayName` in ~/.claude.json only
 * ever carries the first name — confirmed on a real account — so a single-word name can't yield
 * first+last initials the naive way. We recover the surname's initial from the email's local-part,
 * matching Lucca's <first-initial><surname>@… convention (and claude.ai's own avatar, which does
 * know the full name).
 */
import { describe, it, expect } from 'vitest';
import { initials } from '../src/lib/format.js';

describe('initials', () => {
  it('derives the surname initial from a Lucca-style email when the name is first-name-only', () => {
    expect(initials('Lilian', 'larago@luccasoftware.com')).toBe('LA');
  });

  it('is case-insensitive matching the leading letter', () => {
    expect(initials('lilian', 'Larago@luccasoftware.com')).toBe('LA');
  });

  it('uses first-letter-of-first-word + first-letter-of-second-word for a full name', () => {
    expect(initials('Lilian Arago', 'larago@luccasoftware.com')).toBe('LA');
  });

  it('falls back to the first two letters when the email does not fit the convention', () => {
    expect(initials('Lilian', 'someone-else@luccasoftware.com')).toBe('LI');
    expect(initials('Lilian', null)).toBe('LI');
  });

  it('falls back to the email local-part when there is no name at all', () => {
    expect(initials(null, 'larago@luccasoftware.com')).toBe('LA');
    expect(initials(null, 'jean.dupont@luccasoftware.com')).toBe('JD');
    expect(initials('', 'x@luccasoftware.com')).toBe('X');
  });

  it('returns a placeholder when neither name nor email is usable', () => {
    expect(initials(null, null)).toBe('?');
    expect(initials('', '')).toBe('?');
  });
});
