/*
 * Raccourcis clavier (src/lib/shortcuts.js) : correspondance d'un évènement avec un binding.
 *
 * Bug vécu : sur Mac, ⌥ + chiffre produit un caractère composé (`¡`, `™`, `£`…), donc `e.key` ne
 * vaut jamais '1' et les raccourcis ⌥1…⌥6 étaient injoignables. `e.code` (`Digit1`) nomme la touche
 * physique quelle que soit la disposition : c'est le repli quand `e.key` n'est pas alphanumérique —
 * et seulement alors, sinon une disposition AZERTY ferait matcher la touche physique au lieu de la
 * lettre tapée. Même repli à l'enregistrement d'un binding (keysFromEvent), sinon ⌥1 se stockait `¡`.
 */
import { describe, it, expect } from 'vitest';
import { matchesEvent, keysFromEvent } from '../src/lib/shortcuts.js';

const ev = (o) => ({ key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });

describe('shortcuts — ⌥ + chiffre', () => {
  it('matche alt+1 quand e.key est le caractère composé et e.code Digit1', () => {
    expect(matchesEvent({ alt: true, key: '1' }, ev({ altKey: true, key: '¡', code: 'Digit1' }))).toBe(true);
  });

  it('enregistre la touche physique, pas le caractère composé', () => {
    expect(keysFromEvent(ev({ altKey: true, key: '¡', code: 'Digit1' }))).toEqual({ key: '1', alt: true });
  });

  it('ne se rabat pas sur e.code quand e.key est déjà une lettre ou un chiffre', () => {
    // touche physique Q (KeyQ) qui produit « a » sur une autre disposition : c'est « a » qui compte
    expect(matchesEvent({ mod: true, key: 'q' }, ev({ metaKey: true, key: 'a', code: 'KeyQ' }))).toBe(false);
    expect(matchesEvent({ mod: true, key: 'a' }, ev({ metaKey: true, key: 'a', code: 'KeyQ' }))).toBe(true);
    expect(keysFromEvent(ev({ metaKey: true, key: 'a', code: 'KeyQ' }))).toEqual({ key: 'a', mod: true });
  });

  it('reste exact sur les modificateurs', () => {
    expect(matchesEvent({ alt: true, key: '1' }, ev({ key: '1', code: 'Digit1' }))).toBe(false);
    expect(matchesEvent({ mod: true, key: 'p' }, ev({ metaKey: true, key: 'p', code: 'KeyP' }))).toBe(true);
  });
});
