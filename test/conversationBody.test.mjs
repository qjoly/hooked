/*
 * conversationBody (server/tmux.js) : extrait le corps STABLE d'une capture de pane, c.-à-d. tout ce
 * qui précède la dernière invite ❯ (boîte de saisie, ligne de mode « ⏵⏵ … (shift+tab to cycle) »,
 * lignes de sous-agents « ○ … »). C'est la brique qui rend paneActiveSync fiable : sur un pane au
 * repos le FOOTER « respire » (tips qui tournent, compteur, curseur) alors que la conversation, elle,
 * ne bouge pas → si on comparait tout le texte, un pane idle passerait pour actif. Ce test verrouille :
 *   • deux captures qui ne diffèrent QUE par le footer/spinner → même corps (pane vu « statique ») ;
 *   • une ligne de conversation qui s'ajoute (streaming) → corps différent (pane vu « actif »).
 */
import { describe, it, expect } from 'vitest';
import { conversationBody } from '../server/tmux.js';

// Écran réaliste : quelques lignes de conversation, la boîte de saisie ❯, puis le footer de mode.
const screen = (bodyLines, footer) => [...bodyLines, '', '❯ ', ...footer].join('\n');

const FOOTER_A = ['  ⏵⏵ auto mode on (shift+tab to cycle)'];
const FOOTER_B = ['  · Tip: /btw pour une question en passant'];      // le footer « respire »

describe('conversationBody — corps stable de la capture pane', () => {
  const body = ['user: fixe le bug', '', '● Voici la réponse finale.'];

  it('ignore le footer : même corps quand SEUL le footer/mode change', () => {
    const a = conversationBody(screen(body, FOOTER_A));
    const b = conversationBody(screen(body, FOOTER_B));
    expect(a).toBe(b); // pane vu « statique » → refineWithPane pourra rétrograder en waiting
  });

  it('détecte le streaming : une ligne de conversation ajoutée change le corps', () => {
    const before = conversationBody(screen(body, FOOTER_A));
    const after = conversationBody(screen([...body, ' et une précision qui s\'écrit…'], FOOTER_A));
    expect(after).not.toBe(before); // pane vu « actif » → reste working (en écriture)
  });

  it('sans invite ❯ (écran plein / menu) : retombe sur tout le texte moins les lignes vides de queue', () => {
    const txt = 'ligne 1\nligne 2\n\n\n';
    expect(conversationBody(txt)).toBe('ligne 1\nligne 2');
  });
});
