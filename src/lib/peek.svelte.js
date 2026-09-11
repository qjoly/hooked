// La touche modificatrice du « go to definition », suivie une seule fois pour toute
// l'application. Rien d'autre : la carte de définition (DefPeek) est ancrée dans le diff et
// tient elle-même son contenu et sa pile de navigation — il n'y a pas d'état global à
// partager, et un panneau unique aurait dû être coordonné entre les lentilles pour rien.

import { isMac } from './shortcuts.js';

// ⌃-clic sous macOS EST un clic droit (il ouvre le menu contextuel) : on n'y écoute que ⌘, et
// ⌃ partout ailleurs. Jamais les deux, sinon le geste vole le menu contextuel des Mac.
export const modHeld = (e) => (isMac ? !!e.metaKey : !!e.ctrlKey);

export const peek = $state({ mod: false });

// `blur` et `visibilitychange` sont OBLIGATOIRES : un ⌘-Tab quitte la fenêtre sans jamais
// livrer le keyup, et le mode resterait collé au retour — tout le code se croirait cliquable.
export function trackModifier() {
  if (typeof window === 'undefined') return () => {};
  const down = (e) => { if (modHeld(e)) peek.mod = true; };
  const up = (e) => { if (!modHeld(e)) peek.mod = false; };
  const off = () => { peek.mod = false; };
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', off);
  document.addEventListener('visibilitychange', off);
  return () => {
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
    window.removeEventListener('blur', off);
    document.removeEventListener('visibilitychange', off);
  };
}
