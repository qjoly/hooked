/*
 * parseSpinner — détection du spinner d'activité du footer Claude Code (server/tmux.js).
 * Régression ciblée : le spinner ANIME son glyphe (cycle observé en live : ✻ ✽ ✶ ✢ · et « * ») ;
 * une liste de glyphes figée ratait « * » (astérisque) → ~1 frame sur 6 non détectée → l'état
 * clignotait working↔waiting. On teste chaque frame du cycle + le rejet du format « fini » + le
 * bornage au footer (spinner cité loin au-dessus de l'invite = ignoré).
 */
import { describe, it, expect } from 'vitest';
import { parseSpinner } from '../server/tmux.js';

// footer réaliste : spinner puis quelques lignes de chrome puis l'invite ❯ (dans la fenêtre de 14).
const screen = (spinnerLine, gap = 4) =>
  ['… conversation …', spinnerLine, ...Array(gap).fill('  · Tip: /btw pour une question'), '❯ '].join('\n');

describe('parseSpinner — cycle de glyphes animé', () => {
  for (const g of ['✻', '✽', '✶', '✢', '✳', '·', '*']) {
    it(`détecte la frame « ${g} »`, () => {
      expect(parseSpinner(screen(`${g} Quantumizing… (7m 13s · ↓ 29.3k tokens)`))).toBe('Quantumizing');
    });
  }

  it('gère l\'ellipse « ... » (3 points) autant que « … »', () => {
    expect(parseSpinner(screen('* Planning... (1m 14s · thinking)'))).toBe('Planning');
  });

  it('capture un libellé avec chiffres/slash (Claude affiche la TODO en cours, pas qu\'un gérondif)', () => {
    expect(parseSpinner(screen('✳ Recreating talos-mono for IDEM-4/5… (1m 18s · ↓ 2.3k tokens · thinking with high effort)')))
      .toBe('Recreating talos-mono for IDEM-4/5');
  });

  it('rejette le footer FINI « <glyphe> Verbe for <durée> » (pas de …/parenthèse)', () => {
    expect(parseSpinner(screen('✻ Churned for 13m 46s'))).toBe(null);
    expect(parseSpinner(screen('❄ Brewed for 4m 7s · 1 monitor still running'))).toBe(null);
  });

  it('ignore un spinner CITÉ loin au-dessus du footer (hors des 14 lignes)', () => {
    const lines = ['✻ Accomplishing… (3m 25s · cité dans la conversation)', ...Array(20).fill('corps du message'), '❯ '];
    expect(parseSpinner(lines.join('\n'))).toBe(null);
  });

  it('trouve le spinner même avec de la chrome (todo, bannière) sous lui, tant que dans la fenêtre', () => {
    const lines = ['… conv …', '* Cultivating… (33m · ↓ 97k tokens)', '  ◻ tâche 1', '  ◻ tâche 2', '  Update available!', '─────', '❯ Press up to edit queued messages'];
    expect(parseSpinner(lines.join('\n'))).toBe('Cultivating');
  });

  it('rien à parser → null', () => {
    expect(parseSpinner('just some text\n❯ ')).toBe(null);
  });
});
