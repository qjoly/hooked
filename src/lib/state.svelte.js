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
  pinned: persisted.pinned ?? [],       // [sessionId] → sessions épinglées, remontées en tête de sidebar
  names: persisted.names ?? {},         // { [sessionId]: titre custom } → renommage local (comme les pins)
  focus: persisted.focus ?? false,      // mode focus : discussion plein écran (header global + sidebar repliés)
  sidebarPeek: false,                   // (transitoire) ré-ouverture ponctuelle de la sidebar pendant le focus
  modal: null,               // { type, data } | null
  tick: 0,                   // incrémenté à chaque évènement live → relance les effets
  theme: readTheme(),        // 'system' | 'light' | 'dark' (persisté à part, cf. app.html)
});

if (typeof localStorage !== 'undefined') {
  $effect.root(() => {
    $effect(() => {
      const snapshot = { hideOld: ui.hideOld, collapsed: ui.collapsed, pinned: ui.pinned, names: ui.names, focus: ui.focus };
      try { localStorage.setItem(LS_KEY, JSON.stringify(snapshot)); } catch {}
    });
  });
}

// épingle / désépingle une session (toggle). Persisté via l'effet ci-dessus.
export function togglePin(id) {
  ui.pinned = ui.pinned.includes(id) ? ui.pinned.filter((x) => x !== id) : [...ui.pinned, id];
}

// renomme une session (titre custom local, persisté comme les pins). Vide/blanc → on retire
// la surcharge et on retombe sur le titre auto (1er prompt / ai-title du transcript).
export function renameSession(id, name) {
  const next = { ...ui.names };
  if (name && name.trim()) next[id] = name.trim().slice(0, 120);
  else delete next[id];
  ui.names = next;
}

// titre à afficher pour une session : surcharge custom si présente, sinon titre auto.
export function sessionTitle(s) {
  return (s && ui.names[s.id]) || (s && s.title) || '(sans titre)';
}

// mode focus : masque le header global + replie la sidebar → la discussion prend tout l'espace.
export function toggleFocus() {
  ui.focus = !ui.focus;
  if (!ui.focus) ui.sidebarPeek = false; // on repart « sidebar repliée » au prochain focus
}
// ré-ouvre / referme ponctuellement la sidebar pendant le focus (sans quitter le focus).
export function toggleSidebarPeek() { ui.sidebarPeek = !ui.sidebarPeek; }

// ─── Thème (clair / sombre / système) ──────────────────────────────────────────────────────
// Persisté sous une clé dédiée ('hooked.theme'), lue aussi par le script anti-FOUC de app.html.
// 'system' (défaut) = aucun data-theme → prefers-color-scheme décide ; 'light'/'dark' = forcé.
const THEME_KEY = 'hooked.theme';
const THEME_ORDER = ['system', 'light', 'dark'];
function readTheme() {
  if (typeof localStorage === 'undefined') return 'system';
  try { const t = localStorage.getItem(THEME_KEY); return THEME_ORDER.includes(t) ? t : 'system'; }
  catch { return 'system'; }
}
// pose (ou retire) l'attribut data-theme sur <html> selon le choix courant.
function applyTheme() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (ui.theme === 'light' || ui.theme === 'dark') root.setAttribute('data-theme', ui.theme);
  else root.removeAttribute('data-theme'); // 'system' → laisse la media query décider
}
export function setTheme(t) {
  ui.theme = THEME_ORDER.includes(t) ? t : 'system';
  try { localStorage.setItem(THEME_KEY, ui.theme); } catch {}
  applyTheme();
}
// cycle Système → Clair → Sombre → Système… (le bouton du header appelle ça).
export function cycleTheme() {
  setTheme(THEME_ORDER[(THEME_ORDER.indexOf(ui.theme) + 1) % THEME_ORDER.length]);
}

export const data = $state({ sessions: [] });

export async function loadSessions() {
  try { data.sessions = await getSessions(); } catch (_) {}
}

// Version du build front (générée par SvelteKit, change à chaque build). Sert à l'auto-reload :
// si le service est redéployé avec un nouveau front, on le détecte à la reconnexion SSE.
let loadedVersion = null;
async function appVersion() {
  try { const r = await fetch('/_app/version.json', { cache: 'no-store' }); return (await r.json()).version; }
  catch { return null; }
}

let started = false;
export function startLive() {
  if (started) return; // une seule connexion SSE pour toute la durée de vie de l'app
  started = true;
  loadSessions();
  appVersion().then((v) => { loadedVersion = v; }); // version de référence (au chargement)
  connectSSE({
    onOpen: async () => {
      ui.live = true;
      // reconnexion : si le build du front a changé (service redéployé), on recharge la page
      // pour servir la nouvelle version. Pas de reload au 1er connect (loadedVersion = la même).
      if (loadedVersion) { const v = await appVersion(); if (v && v !== loadedVersion) location.reload(); }
    },
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
