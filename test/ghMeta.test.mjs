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
