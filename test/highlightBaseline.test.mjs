/*
 * Filet de caractérisation STRICT du highlighter.
 *
 * highlight.test.mjs vérifie des propriétés (`toContain`) : il laisse passer un changement de
 * markup. Ce fichier-ci fige la sortie OCTET POUR OCTET sur un corpus par langage
 * (test/fixtures/highlight/). C'est le filet qui rend sûre l'extraction de `scanTokens` :
 * le rendu ne doit pas bouger d'un caractère.
 *
 * Une baseline se met à jour DÉLIBÉRÉMENT, jamais pour faire passer un test :
 *   node --input-type=module -e "import {SAMPLES} from './test/fixtures/highlight/samples.mjs';
 *     import {highlight} from './src/lib/highlight.js'; import fs from 'node:fs';
 *     const o={}; for (const s of SAMPLES) o[s.name]=highlight(s.code,s.lang);
 *     fs.writeFileSync('test/fixtures/highlight/baseline.json', JSON.stringify(o,null,2)+'\n');"
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLES } from './fixtures/highlight/samples.mjs';
import { highlight } from '../src/lib/highlight.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/highlight/baseline.json'), 'utf8'));

describe('highlight — baseline stricte (anti-régression de refactor)', () => {
  it('le corpus et la baseline se recouvrent exactement', () => {
    expect(SAMPLES.map((s) => s.name).sort()).toEqual(Object.keys(baseline).sort());
  });

  for (const s of SAMPLES) {
    it(`${s.name} rend exactement la baseline`, () => {
      expect(highlight(s.code, s.lang)).toBe(baseline[s.name]);
    });
  }

  it('reste déterministe entre deux appels (regex collantes réutilisées)', () => {
    for (const s of SAMPLES) expect(highlight(s.code, s.lang)).toBe(highlight(s.code, s.lang));
  });
});
