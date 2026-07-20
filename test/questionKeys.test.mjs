import { describe, it, expect } from 'vitest';
import { questionKeys } from '../server/tmux.js';

// Régression : en CHOIX UNIQUE, Entrée valide l'option ET passe seule à l'onglet suivant, donc
// un Right en plus sauterait une question et désynchroniserait le TUI (« mauvaise réponse reçue »
// sur les prompts à plusieurs questions). En CHOIX MULTIPLE, Entrée ne fait que cocher → il faut
// bien un Right pour changer d'onglet.
describe('questionKeys', () => {
  it('mono sélectionné : Down×idx + Enter, PAS de Right (Entrée avance seule)', () => {
    expect(questionKeys({ multi: false, indices: [2] })).toEqual(['Down', 'Down', 'Enter']);
  });
  it('multi : Enter par option cochée + Right final', () => {
    expect(questionKeys({ multi: true, indices: [0, 2] })).toEqual(['Enter', 'Down', 'Down', 'Enter', 'Right']);
  });
  it('mono sans sélection : Right pour ne pas rester bloqué', () => {
    expect(questionKeys({ multi: false, indices: [] })).toEqual(['Right']);
  });
});
