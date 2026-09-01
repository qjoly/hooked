/*
 * Commande de reprise manuelle affichée par le bouton « Copy resume command ».
 *
 * Ce qui mérite un test ici, c'est le QUOTING : le chemin vient d'un dossier réel de l'utilisateur,
 * donc espaces et apostrophes sont possibles, et une commande mal quotée collée dans un terminal
 * fait pire que rien (elle s'exécute à moitié).
 */
import { describe, it, expect } from 'vitest';
import { resumeCommand } from '../src/lib/format.js';

describe('resumeCommand', () => {
  it('builds a cd + resume pair', () => {
    expect(resumeCommand({ id: 'abc-123', project: '/Users/q/code' }))
      .toBe("cd '/Users/q/code' && claude --resume=abc-123");
  });

  it('quotes a path containing spaces', () => {
    expect(resumeCommand({ id: 'x', project: '/tmp/mon projet' }))
      .toBe("cd '/tmp/mon projet' && claude --resume=x");
  });

  it('survives an apostrophe in the path', () => {
    // idiome POSIX : on ferme la quote, on échappe l'apostrophe, on rouvre
    expect(resumeCommand({ id: 'x', project: "/tmp/l'ete" }))
      .toBe("cd '/tmp/l'\\''ete' && claude --resume=x");
  });

  it('falls back to cwd when project is absent', () => {
    expect(resumeCommand({ id: 'x', cwd: '/srv' })).toBe("cd '/srv' && claude --resume=x");
  });

  it('drops the cd when no directory is known', () => {
    expect(resumeCommand({ id: 'x' })).toBe('claude --resume=x');
  });

  it('returns nothing without a session id', () => {
    for (const junk of [null, undefined, {}, { project: '/tmp' }]) {
      expect(resumeCommand(junk)).toBe('');
    }
  });
});
