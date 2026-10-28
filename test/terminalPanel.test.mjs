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
const TERM = fs.readFileSync(new URL('../src/lib/components/Terminal.svelte', import.meta.url), 'utf8');
const CSS = fs.readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');

describe('terminal panel', () => {
  it('gates the panel on termOpen alone', () => {
    expect(SRC).toContain('{#if termOpen}');
    // toute condition supplémentaire peut être fausse alors que le tiroir est masqué
    expect(SRC).not.toMatch(/\{#if termOpen &&/);
  });

  it('gates the drawer on the exact complement', () => {
    expect(SRC).toContain('{#if !termOpen}');
  });

  // jget renvoie le corps brut, jpost l'enveloppe dans `data` — confondre les deux formes levait une
  // TypeError silencieuse dans refreshTerms, donc la liste des onglets restait vide en permanence
  // alors que les PTY existaient bien côté serveur.
  it('reads the terminal list at the shape jget actually returns', () => {
    expect(SRC).toContain('terms = (res.terminals || [])');
    expect(SRC).not.toContain('res.data.terminals');
  });

  it('folds the panel back when the last terminal is gone', () => {
    // refreshTerms est le seul endroit où `terms` est réassigné, donc le seul où poser l'invariant
    const body = SRC.slice(SRC.indexOf('async function refreshTerms'));
    expect(body.slice(0, body.indexOf('\n  }'))).toMatch(/if \(!terms\.length\) termOpen = false/);
  });

  // `--code-bg` is dark in EVERY theme, whereas `--fg` is #181b20 in light themes: pairing them gave
  // a black-on-black terminal. The terminal must read its ink from the code-surface tokens, and
  // those must stay readable on the code surface in every scheme and theme.
  it('takes the terminal foreground from the code-surface ink, never the UI ink', () => {
    expect(TERM).toContain("v('--code-fg'");
    expect(TERM).not.toMatch(/['"]--fg['"]/);
  });

  it('keeps the code-surface ink readable on the code surface in every theme', () => {
    const scale = Object.fromEntries([...CSS.matchAll(/--(r\d+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
    const resolve = (value) => value.replace(/^var\(--(r\d+)\)$/, (_, name) => scale[name] ?? value);
    const tokens = (name) => [...CSS.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, 'g'))].map((m) => resolve(m[1].trim()));

    const backgrounds = tokens('code-bg');
    const inks = tokens('code-fg');
    expect(backgrounds.length).toBeGreaterThan(0);
    expect(inks.length).toBeGreaterThan(0);
    // worst case across every definition, so any scheme/theme combination is covered
    const darkestInk = Math.min(...inks.map(luminance));
    const lightestBackground = Math.max(...backgrounds.map(luminance));
    expect(contrast(darkestInk, lightestBackground)).toBeGreaterThanOrEqual(4.5);
  });
});

// WCAG relative luminance of a #rrggbb colour; anything else (unresolved var, rgba) fails loudly.
function luminance(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(match[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
