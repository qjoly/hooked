/*
 * Le panneau terminal et son tiroir doivent être des branches EXACTEMENT complémentaires.
 *
 * Régression vécue : le panneau était gardé par `termOpen && terms.length` et le tiroir par
 * `!termOpen`. Changer de session vidait `terms` (chaque session ne liste que ses terminaux) sans
 * remettre `termOpen` à false → les deux gardes étaient fausses en même temps, plus rien ne
 * s'affichait, et comme le tiroir était le seul moyen de rouvrir, l'UI terminal devenait
 * inaccessible jusqu'au rechargement de la page. Le PTY, lui, tournait toujours côté serveur.
 *
 * On teste la source plutôt que le rendu : c'est la garde elle-même qui était fausse, et la vérifier
 * ne demande pas de monter le composant ni un DOM.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../src/lib/components/SessionDetail.svelte', import.meta.url), 'utf8');

describe('terminal panel', () => {
  it('gates the panel on termOpen alone', () => {
    expect(SRC).toContain('{#if termOpen}');
    // toute condition supplémentaire peut être fausse alors que le tiroir est masqué
    expect(SRC).not.toMatch(/\{#if termOpen &&/);
  });

  it('gates the drawer on the exact complement', () => {
    expect(SRC).toContain('{#if !termOpen}');
  });

  it('folds the panel back when the last terminal is gone', () => {
    // refreshTerms est le seul endroit où `terms` est réassigné, donc le seul où poser l'invariant
    const body = SRC.slice(SRC.indexOf('async function refreshTerms'));
    expect(body.slice(0, body.indexOf('\n  }'))).toMatch(/if \(!terms\.length\) termOpen = false/);
  });
});
