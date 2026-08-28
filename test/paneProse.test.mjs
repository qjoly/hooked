/*
 * lastPaneProse (server/tmux.js) : dernier bloc de PROSE de l'assistant dans une capture de pane.
 *
 * Pourquoi ça existe : tant qu'une AskUserQuestion (ou un ExitPlanMode) attend sa réponse, Claude
 * Code n'a RIEN écrit du tour dans le transcript .jsonl — mesuré à la seconde : thinking + texte +
 * tool_use y tombent d'un SEUL coup à l'instant de la réponse (leurs `timestamp` restent ceux du
 * streaming, ce qui rend le retard invisible dans le fichier après coup). Le texte qui introduit la
 * question — celui dont on a besoin POUR répondre — n'existe donc que dans la pane. Ce test
 * verrouille l'extraction : on prend la prose, pas les blocs d'outil ni les avis système, et la
 * boîte de question (bordures en colonne 0) borne bien le bloc.
 */
import { describe, it, expect } from 'vitest';
import { lastPaneProse } from '../server/tmux.js';

// Capture réaliste : un outil, la prose d'introduction, puis la boîte de question EN ATTENTE.
const PENDING = [
  '⏺ Running grep -rn "CallbackUri" … · 2s',
  '  ⎿  $ grep -rn "CallbackUri" Application',
  '',
  '  Searched for 1 pattern, ran 6 shell commands',
  '',
  '⏺ J\'ai le contexte complet. Voici le groupe B.',
  '',
  '  Le conflit, en une phrase',
  '',
  '  Master persiste l\'URI sur le workflow — une seule Uri par step producteur.',
  '',
  '  | Fichier      | Master                 |',
  '  | ------------ | ---------------------- |',
  '  | Orchestrator | RequireBackupUri(…)    |',
  '',
  '╭──────────────────────────────────────────────╮',
  '│ Comment résoudre le conflit ?                │',
  '│  1. Option 1 : pluraliser les deux           │',
  '╰──────────────────────────────────────────────╯',
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
].join('\n');

describe('lastPaneProse — introduction d\'une question en attente', () => {
  it('extrait le dernier bloc de prose, dédenté, bordé par la boîte de question', () => {
    const out = lastPaneProse(PENDING);
    expect(out.split('\n')[0]).toBe("J'ai le contexte complet. Voici le groupe B.");
    expect(out).toContain('Le conflit, en une phrase');
    expect(out).toContain('| Fichier      | Master                 |'); // colonnes préservées
    expect(out).not.toContain('╭');            // la boîte de question borne le bloc
    expect(out).not.toContain('shift+tab');    // ni le footer
    expect(out.endsWith('|')).toBe(true);      // pas de lignes vides de queue
  });

  it('coupe la ligne de résumé d\'activité collée sous la prose', () => {
    const withSummary = [
      '⏺ La prose utile.',
      '',
      '  Searched for 6 patterns, read 1 file, listed 2 directories, ran 18 shell commands',
      '',
      '╭────────────────────╮',
      '│ Une question ?     │',
      '╰────────────────────╯',
    ].join('\n');
    expect(lastPaneProse(withSummary)).toBe('La prose utile.');
  });

  it('ignore les blocs d\'outil (ligne de résultat ⎿) et les avis système', () => {
    const tail = [
      PENDING,
      '',
      '⏺ Background command "node sample.cjs" completed (exit code 0)',
      '',
      '⏺ User answered Claude\'s questions:',
      '  ⎿  · Quelle direction ? → Option 1',
    ].join('\n');
    expect(lastPaneProse(tail).split('\n')[0]).toBe("J'ai le contexte complet. Voici le groupe B.");
  });

  it('s\'arrête à la dernière invite ❯ (boîte de saisie, pas de la conversation)', () => {
    const withPrompt = [
      '⏺ La vraie dernière prose.',
      '',
      '❯ un brouillon ⏺ pas de la prose',
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ].join('\n');
    expect(lastPaneProse(withPrompt)).toBe('La vraie dernière prose.');
  });

  it('rend null sans prose (pane injoignable, écran vide, que des outils)', () => {
    expect(lastPaneProse(null)).toBeNull();
    expect(lastPaneProse('')).toBeNull();
    expect(lastPaneProse('⏺ Running ls · 1s\n  ⎿  $ ls')).toBeNull();
  });
});
