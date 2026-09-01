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
import { bangKind } from '../src/lib/format.js';
import { parseBangCommand, formatLocalCommand, stripAnsi } from '../server/agent.js';

describe('parseBangCommand', () => {
  it('reconnaît une commande, avec ou sans espace après le !', () => {
    expect(parseBangCommand('!ls -la')).toEqual({ command: 'ls -la', interactive: false });
    expect(parseBangCommand('! mise deploy')).toEqual({ command: 'mise deploy', interactive: false });
    expect(parseBangCommand('!  git status  ')).toEqual({ command: 'git status', interactive: false });
  });

  it('garde les pipes, redirections et guillemets tels quels', () => {
    // La commande part à `sh -c` : c'est une LIGNE DE SHELL écrite par l'utilisateur, pas une
    // liste d'arguments — la démembrer casserait tout ce qui fait l'intérêt du mode bash.
    expect(parseBangCommand('!git log --oneline | head -3').command).toBe('git log --oneline | head -3');
    expect(parseBangCommand('!echo "a b" > /tmp/x').command).toBe('echo "a b" > /tmp/x');
  });

  it('laisse passer la prose : un ! ailleurs qu\'en tête n\'est pas une commande', () => {
    for (const t of ['hello!', 'wow ! that works', 'Fix the bug!', '']) {
      expect(parseBangCommand(t)).toBe(null);
    }
  });

  it('ignore « ! » et « !! » seuls (pas de commande), et « !!! »', () => {
    for (const t of ['!', '!  ', '!!', '!! ', '!!!ls']) expect(parseBangCommand(t)).toBe(null);
  });

  it('accepte une commande multi-lignes', () => {
    expect(parseBangCommand('!for f in *; do\n  echo $f\ndone').command).toBe('for f in *; do\n  echo $f\ndone');
  });

  it('ne lève pas sur une entrée non-string', () => {
    for (const v of [null, undefined, 42, {}, []]) expect(parseBangCommand(v)).toBe(null);
  });
});

describe('formatLocalCommand — bloc fencé `console`', () => {
  // Le compte rendu a DEUX lecteurs : Claude, qui doit y lire une transcription de terminal
  // ordinaire, et l'UI, qui reconnaît le langage `console` pour rendre la bulle comme un terminal
  // (TerminalBlock) au lieu d'un paragraphe. D'où le format unique plutôt qu'un en-tête en prose,
  // que le front aurait dû reconnaître à la phrase — fragile, et impossible à distinguer d'un
  // utilisateur qui l'aurait tapée.
  it('ouvre une fence `console` portant le code de sortie et le dossier', () => {
    const out = formatLocalCommand('git status', 0, 'nothing to commit\n', false, '/tmp/p');
    expect(out.split('\n')[0]).toBe('```console exit=0 cwd=/tmp/p');
    expect(out).toContain('$ git status');
    expect(out).toContain('nothing to commit');
    expect(out.endsWith('```')).toBe(true);
  });

  it('conserve un code de sortie non nul (c\'est ce qui pilote le rendu « échec »)', () => {
    expect(formatLocalCommand('false', 1, '', false, '/tmp')).toContain('exit=1');
  });

  it('signale une sortie tronquée pour que Claude sache qu\'il n\'a pas tout', () => {
    expect(formatLocalCommand('find /', 0, 'x', true, '/tmp')).toContain('truncated=1');
    expect(formatLocalCommand('find /', 0, 'x', false, '/tmp')).not.toContain('truncated');
  });

  it('omet cwd quand il est inconnu, sans laisser `cwd=` vide', () => {
    const out = formatLocalCommand('pwd', 0, '/tmp', false, null);
    expect(out.split('\n')[0]).toBe('```console exit=0');
  });

  it('retire les séquences ANSI : ni Claude ni le HTML n\'en font quoi que ce soit', () => {
    const out = formatLocalCommand('ls', 0, '\x1b[31mrouge\x1b[0m\n', false, '/tmp');
    expect(out).toContain('rouge');
    expect(out).not.toContain('\x1b');
  });

  it('allonge le délimiteur quand la sortie contient elle-même des backticks', () => {
    // Sinon un ``` dans la sortie (un README, un `cat` de doc) fermerait la fence en plein milieu
    // et le reste s'afficherait comme du markdown.
    const out = formatLocalCommand('cat r.md', 0, 'texte\n```js\ncode\n```\n', false, '/tmp');
    expect(out.startsWith('````console')).toBe(true);
    expect(out.endsWith('\n````')).toBe(true);
  });
});

describe('stripAnsi', () => {
  it('retire couleurs, déplacements de curseur et titres de fenêtre', () => {
    expect(stripAnsi('\x1b[1;32mok\x1b[0m')).toBe('ok');
    expect(stripAnsi('a\x1b[2Kb')).toBe('ab');
    expect(stripAnsi('\x1b]0;titre\x07reste')).toBe('reste');
  });

  it('laisse le texte ordinaire intact, sauts de ligne compris', () => {
    expect(stripAnsi('ligne 1\nligne 2\t fin')).toBe('ligne 1\nligne 2\t fin');
  });

  // `!!` : même parsing, seul le TTY change. C'est ce qui débloque tout ce qui refuse de tourner
  // sans terminal — `claude mcp login` en est l'exemple qui a motivé la fonctionnalité.
  describe('parseBangCommand — forme interactive', () => {
    it('marque `!!` comme interactif', () => {
      expect(parseBangCommand('!!claude mcp login mcp-gateway'))
        .toEqual({ command: 'claude mcp login mcp-gateway', interactive: true });
      expect(parseBangCommand('!! vim /tmp/x')).toEqual({ command: 'vim /tmp/x', interactive: true });
    });
    it('distingue `!` de `!!` sur la même commande', () => {
      expect(parseBangCommand('!htop').interactive).toBe(false);
      expect(parseBangCommand('!!htop').interactive).toBe(true);
    });
  });

  // Le front duplique une détection minimale (bangKind) pour choisir le LIBELLÉ et la COULEUR de la
  // bulle. Un doublon de règle de parsing dérive toujours, sauf s'il est tenu par un test : les deux
  // doivent classer la même table de la même façon.
  describe('bangKind (front) est d\'accord avec parseBangCommand (serveur)', () => {
    const TABLE = [
      '!ls -la', '! mise deploy', '!  git status  ', '!git log | head -3', '!echo "a b" > /tmp/x',
      '!!claude mcp login mcp-gateway', '!! vim /tmp/x', '!!htop',
      '!', '!  ', '!!', '!! ', '!!!ls', 'ls', '', 'hello !ls', null, undefined, 42,
      '!for f in *; do\n  echo $f\ndone',
    ];
    it('classe chaque entrée pareil : rien, capture, ou interactif', () => {
      for (const t of TABLE) {
        const srv = parseBangCommand(t);
        const front = bangKind(t);
        const expected = srv === null ? null : (srv.interactive ? 'interactive' : 'shell');
        expect(front, `désaccord sur ${JSON.stringify(t)}`).toBe(expected);
      }
    });
  });
});
