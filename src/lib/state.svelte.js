// État partagé (runes Svelte 5). Un seul objet réactif partagé entre composants.
import { getSessions, connectSSE } from './api.js';

export const ui = $state({
  view: 'sessions',          // 'sessions' | 'stats'
  live: false,               // connexion SSE active ?
  currentSessionId: null,    // session ouverte dans le détail (null = vue d'ensemble)
  statusFilter: 'all',
  search: '',
  hideOld: false,
  collapsed: {},             // { [projet]: true } → groupes repliés dans la sidebar
  modal: null,               // { type, data } | null
  tick: 0,                   // incrémenté à chaque évènement live → relance les effets
});

export const data = $state({ sessions: [] });

export async function loadSessions() {
  try { data.sessions = await getSessions(); } catch (_) {}
}

export function startLive() {
  loadSessions();
  connectSSE({
    onOpen: () => { ui.live = true; },
    onError: () => { ui.live = false; },
    onTick: () => { if (ui.view === 'sessions') refresh(); },
  });
  // filet : rafraîchit la vue sessions toutes les 5 s même sans évènement
  setInterval(() => { if (ui.view === 'sessions') refresh(); }, 5000);
}

async function refresh() {
  await loadSessions();
  ui.tick++; // signale aux effets (détail de session ouvert, vue d'ensemble…) de se réévaluer
}

export const openModal = (type, data2) => { ui.modal = { type, data: data2 }; };
export const closeModal = () => { ui.modal = null; };
