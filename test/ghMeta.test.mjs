/*
 * ghView — enrichissement PR/issue via le CLI `gh`. On ne teste PAS un vrai appel `gh`
 * (dépend de l'auth réseau) ; on couvre le garde-fou d'URL : toute entrée qui ne matche
 * pas une URL GitHub pull/issue renvoie null AVANT de spawn `gh` (jamais throw).
 */
import { describe, it, expect } from 'vitest';
import { ghView } from '../server/ghMeta.js';

describe('ghView URL guard', () => {
  it('returns null for non-GitHub / malformed URLs without throwing', async () => {
    for (const bad of [
      null,
      undefined,
      '',
      'not a url',
      'https://example.com/foo/bar/pull/1',
      'https://github.com/owner/repo', // no pull/issues segment
      'https://github.com/owner/repo/commit/abc', // wrong kind
      'https://github.com/owner/repo/pull/', // missing number
    ]) {
      await expect(ghView(bad)).resolves.toBeNull();
    }
  });
});

describe('ghMeta cadence and batching', async () => {
  const { viewTtl, batchQuery } = await import('../server/ghMeta.js');
  const now = Date.parse('2026-11-12T12:00:00Z');
  const ago = (min) => new Date(now - min * 60_000).toISOString();

  it('re-reads busy PRs often, quiet ones less, finished ones never', () => {
    expect(viewTtl({ state: 'OPEN', updatedAt: ago(5) }, now)).toBe(60_000);
    expect(viewTtl({ state: 'OPEN', updatedAt: ago(90) }, now)).toBe(5 * 60_000);
    expect(viewTtl({ state: 'OPEN', updatedAt: ago(3000) }, now)).toBe(30 * 60_000);
    expect(viewTtl({ state: 'merged' }, now)).toBe(Infinity);
    expect(viewTtl(null, now)).toBe(15 * 60_000);
  });

  it('aliases each item and only declares the fragments it uses', () => {
    const q = batchQuery([{ owner: 'o', name: 'r', kind: 'pr', number: 1 }, { owner: 'o', name: 'r', kind: 'pr', number: 2 }]);
    expect(q).toContain('i0: repository(owner: "o", name: "r") { pullRequest(number: 1) { ...P } }');
    expect(q).toContain('i1: repository');
    expect(q).toContain('fragment P on PullRequest');
    expect(q).not.toContain('fragment I');
  });
});
