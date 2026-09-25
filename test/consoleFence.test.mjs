/*
 * Blocs `console` (src/lib/format.js → isCommandTranscript) : seul le compte rendu d'un `!commande`
 * produit par hooked porte `exit=` dans son info-string (server/agent.js → formatLocalCommand). Un
 * bloc ```console écrit par Claude n'a pas ce marqueur : c'est du code ordinaire, et sa première
 * ligne n'est pas une commande à promouvoir en en-tête de terminal.
 */
import { describe, it, expect } from 'vitest';
import { mdSegments, isCommandTranscript } from '../src/lib/format.js';

const code = (md) => mdSegments(md).find((s) => s.type === 'code');

describe('isCommandTranscript', () => {
  it('reconnaît le compte rendu produit par hooked', () => {
    expect(isCommandTranscript(code('```console exit=0 cwd=/tmp\n$ ls\na b\n```'))).toBe(true);
    expect(isCommandTranscript(code('```console exit=127\n$ nope\n```'))).toBe(true);
  });

  it('laisse un bloc console ordinaire au rendu de code', () => {
    expect(isCommandTranscript(code('```console\n$ ls\na b\n```'))).toBe(false);
  });

  it('ignore les autres langages et les segments texte', () => {
    expect(isCommandTranscript(code('```js exit=0\nx\n```'))).toBe(false);
    expect(isCommandTranscript(mdSegments('plain text')[0])).toBe(false);
    expect(isCommandTranscript(null)).toBe(false);
  });
});
