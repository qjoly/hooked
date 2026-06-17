// État partagé (runes Svelte 5). Un seul objet réactif partagé entre composants.
// La navigation (vue courante, session ouverte, écran « nouvelle session ») n'est PLUS
// ici : elle est portée par l'URL (routing SvelteKit). Ne restent que les filtres de la
// sidebar, l'état live (SSE), le tick de rafraîchissement et la modale.
import { getSessions, connectSSE } from './api.js';

const LS_KEY = 'hooked.ui';
const persisted = (() => {
  if (typeof localStorage === 'undefined') return {};
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch { return {}; }
})();

export const ui = $state({
  live: false,               // connexion SSE active ?
  statusFilter: 'all',
  search: '',
  hideOld: persisted.hideOld ?? false,
  collapsed: persisted.collapsed ?? {}, // { [projet]: true } → groupes repliés dans la sidebar
  modal: null,               // { type, data } | null
  tick: 0,                   // incrémenté à chaque évènement live → relance les effets
});

if (typeof localStorage !== 'undefined') {
  $effect.root(() => {
    $effect(() => {
      const snapshot = { hideOld: ui.hideOld, collapsed: ui.collapsed };
      try { localStorage.setItem(LS_KEY, JSON.stringify(snapshot)); } catch {}
    });
  });
}

export const data = $state({ sessions: [] });

export async function loadSessions() {
  try { data.sessions = await getSessions(); } catch (_) {}
}

let started = false;
export function startLive() {
  if (started) return; // une seule connexion SSE pour toute la durée de vie de l'app
  started = true;
  loadSessions();
  connectSSE({
    onOpen: () => { ui.live = true; },
    onError: () => { ui.live = false; },
    onTick: () => { refresh(); },
  });
  // filet : rafraîchit la liste toutes les 5 s même sans évènement
  setInterval(refresh, 5000);
}

async function refresh() {
  await loadSessions();
  ui.tick++; // signale aux effets (détail de session ouvert, vue d'ensemble…) de se réévaluer
}

export const openModal = (type, data2) => { ui.modal = { type, data: data2 }; };
export const closeModal = () => { ui.modal = null; };
