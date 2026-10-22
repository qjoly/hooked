import { describe, it, expect } from 'vitest';
import { ghFilter } from '../src/lib/format.js';

const items = [
  { repo: 'une-tasse-de-cafe/blog', title: 'Fix RSS feed' },
  { repo: 'une-tasse-de-cafe/hooked', title: 'Add GitHub filter' },
  { repo: 'LuccaSA/une-tasse-de-cafe', title: 'Fix chart' },
];
const run = (q) => items.filter(ghFilter(q).keep).map((x) => x.repo);

describe('ghFilter', () => {
  it('scopes to an org by prefix, not substring', () => {
    expect(run('une-tasse-de-cafe/')).toEqual(['une-tasse-de-cafe/blog', 'une-tasse-de-cafe/hooked']);
  });
  it('scopes to a single repo', () => {
    expect(run('Une-Tasse-De-Cafe/hooked')).toEqual(['une-tasse-de-cafe/hooked']);
  });
  it('combines a scope with free-text words', () => {
    expect(run('une-tasse-de-cafe/ fix')).toEqual(['une-tasse-de-cafe/blog']);
  });
  it('keeps the plain title/repo search', () => {
    expect(run('fix')).toEqual(['une-tasse-de-cafe/blog', 'LuccaSA/une-tasse-de-cafe']);
    expect(run('')).toHaveLength(3);
  });
});
