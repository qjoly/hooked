/*
 * Ce que les hooks comblent quand le transcript est encore un squelette (server/stats.js).
 *
 * Le CLI n'écrit le transcript principal qu'une fois le tour rendu : tant qu'un subagent foreground
 * travaille — un skill lancé en commande slash, /code-review par exemple — le fichier ne porte que
 * deux lignes de file d'attente. La session s'affichait « (sans titre) », sans projet, alors que les
 * évènements de hooks portaient le cwd et le prompt depuis la première seconde.
 */
import { describe, it, expect } from 'vitest';
import { fillFromEvents } from '../server/index.js';

const meta = { cwd: '/Users/me/Sites/hooked', firstPrompt: '/code-review https://github.com/o/r/pull/1' };

describe('fillFromEvents', () => {
  it('donne un projet et un titre à une session que le transcript ne décrit pas encore', () => {
    const s = fillFromEvents({ project: null, projectName: null, title: '(sans titre)', firstPrompt: null }, meta);
    expect(s.project).toBe('/Users/me/Sites/hooked');
    expect(s.projectName).toBe('hooked');
    expect(s.title).toBe('/code-review https://github.com/o/r/pull/1');
    expect(s.firstPrompt).toBe(meta.firstPrompt);
  });

  it('ne touche pas ce que le transcript a déjà dit — il fait autorité', () => {
    const s = fillFromEvents({ project: '/other', projectName: 'other', title: 'Un vrai titre', firstPrompt: 'x' }, meta);
    expect(s).toEqual({ project: '/other', projectName: 'other', title: 'Un vrai titre', firstPrompt: 'x' });
  });

  it('laisse le placeholder quand les hooks n\'ont pas de prompt non plus', () => {
    const s = fillFromEvents({ project: null, projectName: null, title: '(sans titre)', firstPrompt: null },
      { cwd: '/Users/me/Sites/hooked', firstPrompt: null });
    expect(s.projectName).toBe('hooked');
    expect(s.title).toBe('(sans titre)');
  });

  it('sans évènements, rien ne change', () => {
    const before = { project: null, projectName: null, title: '(sans titre)', firstPrompt: null };
    expect(fillFromEvents({ ...before }, null)).toEqual(before);
  });
});
