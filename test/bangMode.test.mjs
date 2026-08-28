/*
 * Mode bash du composer (`!commande`) — server/agent.js.
 *
 * Dans le TUI de Claude Code, un « ! » de tête bascule en mode bash : la commande s'exécute
 * localement et sa sortie rejoint le contexte SANS faire répondre le modèle. Du temps de tmux
 * hooked en héritait gratuitement (le texte était tapé dans le TUI, qui s'en chargeait) ; en entrée
 * stream-json le CLI ne l'interprète plus — mesuré, `!echo x` part au modèle comme du texte
 * ordinaire — donc hooked le réimplémente.
 *
 * Ces tests couvrent les deux parties pures : reconnaître la saisie, et mettre en forme le compte
 * rendu injecté. L'exécution elle-même (spawn + env de login) se vérifie en bout-en-bout.
 */
import { describe, it, expect } from 'vitest';
import { parseBangCommand, formatLocalCommand } from '../server/agent.js';

describe('parseBangCommand', () => {
  it('reconnaît une commande, avec ou sans espace après le !', () => {
    expect(parseBangCommand('!ls -la')).toBe('ls -la');
    expect(parseBangCommand('! mise deploy')).toBe('mise deploy');
    expect(parseBangCommand('!  git status  ')).toBe('git status');
  });

  it('garde les pipes, redirections et guillemets tels quels', () => {
    // La commande part à `sh -c` : c'est une LIGNE DE SHELL écrite par l'utilisateur, pas une
    // liste d'arguments — la démembrer casserait tout ce qui fait l'intérêt du mode bash.
    expect(parseBangCommand('!git log --oneline | head -3')).toBe('git log --oneline | head -3');
    expect(parseBangCommand('!echo "a b" > /tmp/x')).toBe('echo "a b" > /tmp/x');
  });

  it('laisse passer la prose : un ! ailleurs qu\'en tête n\'est pas une commande', () => {
    for (const t of ['hello!', 'wow ! that works', 'Fix the bug!', '']) {
      expect(parseBangCommand(t)).toBe(null);
    }
  });

  it('ignore « ! » seul et « !! » (pas de commande, ou rappel d\'historique shell)', () => {
    for (const t of ['!', '!  ', '!!', '!!ls']) expect(parseBangCommand(t)).toBe(null);
  });

  it('accepte une commande multi-lignes', () => {
    expect(parseBangCommand('!for f in *; do\n  echo $f\ndone')).toBe('for f in *; do\n  echo $f\ndone');
  });

  it('ne lève pas sur une entrée non-string', () => {
    for (const v of [null, undefined, 42, {}, []]) expect(parseBangCommand(v)).toBe(null);
  });
});

describe('formatLocalCommand', () => {
  it('rappelle la commande et son code de sortie', () => {
    const out = formatLocalCommand('git status', 0, 'nothing to commit\n', false);
    expect(out).toContain('exit 0');
    expect(out).toContain('$ git status');
    expect(out).toContain('nothing to commit');
  });

  it('signale une sortie tronquée pour que Claude sache qu\'il n\'a pas tout', () => {
    expect(formatLocalCommand('find /', 0, 'x', true)).toContain('output truncated');
    expect(formatLocalCommand('find /', 0, 'x', false)).not.toContain('truncated');
  });

  it('dit explicitement « pas de sortie » plutôt que de laisser un blanc', () => {
    // Un blanc se lit comme « la commande n'a rien renvoyé » OU « le compte rendu est cassé ».
    expect(formatLocalCommand('true', 0, '', false)).toContain('(no output)');
  });

  it('conserve un code de sortie non nul', () => {
    expect(formatLocalCommand('false', 1, '', false)).toContain('exit 1');
  });
});
