/*
 * Contrat entre le serveur et le chat pour `!!commande`.
 *
 * Le serveur produit un fence ```pty (formatInteractiveCommand) que le front doit reparser en
 * segment de code avec la bonne langue ET les bonnes métadonnées (l'id du PTY, sinon le bloc ne peut
 * pas s'abonner au terminal). Les deux vivent dans des fichiers différents, donc rien ne garantit
 * qu'ils restent d'accord — d'où ce test d'aller-retour plutôt qu'un test de chaque côté.
 */
import { describe, it, expect } from 'vitest';
import { formatInteractiveCommand } from '../server/agent.js';
import { mdSegments } from '../src/lib/format.js';

const roundTrip = (cmd, id, cwd) => {
  const segs = mdSegments(formatInteractiveCommand(cmd, id, cwd));
  return segs.find((s) => s.type === 'code');
};

describe('pty fence round-trip', () => {
  it('carries the terminal id through to the chat block', () => {
    const seg = roundTrip('claude mcp login mcp-gateway', 'term_ab12', '/Users/q/code');
    expect(seg).toBeTruthy();
    expect(seg.lang).toBe('pty');
    expect(seg.meta.id).toBe('term_ab12');
    expect(seg.meta.cwd).toBe('/Users/q/code');
  });

  it('keeps the command readable, so an expired terminal still says what ran', () => {
    const seg = roundTrip('vim /tmp/x', 'term_1', '/tmp');
    expect(seg.code.split('\n')[0]).toBe('$ vim /tmp/x');
  });

  it('does not embed the output — a TUI would flood the transcript', () => {
    const seg = roundTrip('htop', 'term_1', '/tmp');
    expect(seg.code.trim()).toBe('$ htop');
  });

  it('works without a cwd', () => {
    const seg = roundTrip('ls', 'term_1', '');
    expect(seg.lang).toBe('pty');
    expect(seg.meta.id).toBe('term_1');
    expect(seg.meta.cwd).toBeUndefined();
  });

  it('is a different lang from the captured `console` block', () => {
    // sinon `!` et `!!` rendraient le même composant, et l'interactif serait perdu
    expect(roundTrip('ls', 'term_1', '/tmp').lang).not.toBe('console');
  });
});
