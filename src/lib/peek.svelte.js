// État partagé du « go to definition » : la touche modificatrice enfoncée, et le panneau de
// définition. Un seul exemplaire pour toute l'application — le geste part de la review, de la
// vue fichier ou de la conversation, et le panneau est monté une seule fois.

import { isMac } from './shortcuts.js';

// ⌃-clic sous macOS EST un clic droit (il ouvre le menu contextuel) : on n'y écoute que ⌘, et
// ⌃ partout ailleurs. Jamais les deux, sinon le geste vole le menu contextuel des Mac.
export const modHeld = (e) => (isMac ? !!e.metaKey : !!e.ctrlKey);

export const peek = $state({
  mod: false,        // la touche est enfoncée maintenant
  open: false,
  loading: false,
  stack: [],         // pile de navigation : [{ file, rel, line, symbol, rev }]
  result: null,      // dernière réponse de /api/session/symbol
  error: null,
});

export const peekTop = () => peek.stack[peek.stack.length - 1] || null;

export function pushPeek(entry) {
  if (peek.stack.length >= 8) peek.stack.shift(); // profondeur bornée : une pile est une aide, pas un historique
  peek.stack.push(entry);
  peek.open = true;
}
export function popPeek() {
  peek.stack.pop();
  if (!peek.stack.length) closePeek();
}
export function closePeek() {
  peek.open = false;
  peek.stack = [];
  peek.result = null;
  peek.error = null;
  peek.loading = false;
}

// Suivi de la touche. `blur` et `visibilitychange` sont OBLIGATOIRES : un ⌘-Tab quitte la
// fenêtre sans jamais livrer le keyup, et le mode resterait collé au retour.
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
