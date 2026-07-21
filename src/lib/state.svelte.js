// État partagé (runes Svelte 5). Un seul objet réactif partagé entre composants.
// La navigation (vue courante, session ouverte, écran « nouvelle session ») n'est PLUS
// ici : elle est portée par l'URL (routing SvelteKit). Ne restent que les filtres de la
// sidebar, l'état live (SSE), le tick de rafraîchissement et la modale.
import { getSessions, connectSSE, getSettings, saveSettings as apiSaveSettings } from './api.js';
import { NOTIFY_KINDS, notifyKeyFor, countsForBadge } from './notify.js';

const LS_KEY = 'hooked.ui';
const persisted = (() => {
  if (typeof localStorage === 'undefined') return {};
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch { return {}; }
})();

export const ui = $state({
  live: false,               // connexion SSE active ?
  statusFilters: ['all'],    // filtres de statut actifs — Ctrl/⌘+clic sur les chips = multi-sélection
  tagFilters: [],            // tags actifs (transitoire, non persisté) — une session doit porter TOUS ces tags
  search: '',
  hideOld: persisted.hideOld ?? false,
  collapsed: persisted.collapsed ?? {}, // { [projet]: true } → groupes repliés dans la sidebar
  pinned: persisted.pinned ?? [],       // [sessionId] → sessions épinglées, remontées en tête de sidebar
  names: persisted.names ?? {},         // { [sessionId]: titre custom } → renommage local (comme les pins)
  tags: persisted.tags ?? {},           // { [sessionId]: [tag] } → étiquettes locales (ex. "In review", "Pending")
  focus: persisted.focus ?? false,      // mode focus : discussion plein écran (header global + sidebar repliés)
  sidebarPeek: false,                   // (transitoire) ré-ouverture ponctuelle de la sidebar pendant le focus
  modal: null,               // { type, data } | null
  tick: 0,                   // incrémenté à chaque évènement live → relance les effets
  theme: readTheme(),        // 'system' | 'light' | 'dark' (persisté à part, cf. app.html)
  notify: persisted.notify ?? false,    // notifications navigateur (session finie / en attente de toi)
  notifyPinnedOnly: persisted.notifyPinnedOnly ?? false, // if true: only notify for pinned sessions
  diffSplit: persisted.diffSplit ?? false, // render conversation diffs side-by-side (split) instead of unified
});

if (typeof localStorage !== 'undefined') {
  $effect.root(() => {
    $effect(() => {
      const snapshot = { hideOld: ui.hideOld, collapsed: ui.collapsed, pinned: ui.pinned, names: ui.names, tags: ui.tags, focus: ui.focus, notify: ui.notify, notifyPinnedOnly: ui.notifyPinnedOnly, diffSplit: ui.diffSplit };
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

// tags d'une session (tableau, jamais null). Persisté comme les pins/renommages.
export function sessionTags(id) {
  return ui.tags[id] || [];
}
// remplace les tags d'une session (dédupliqués, rognés). Liste vide → on retire l'entrée.
export function setSessionTags(id, list) {
  const clean = [...new Set(list.map((t) => t.trim()).filter(Boolean).map((t) => t.slice(0, 40)))];
  const next = { ...ui.tags };
  if (clean.length) next[id] = clean;
  else delete next[id];
  ui.tags = next;
}
// tous les tags en usage (triés, uniques) — alimente la barre de filtres.
export function allTags() {
  return [...new Set(Object.values(ui.tags).flat())].sort((a, b) => a.localeCompare(b));
}

// titre à afficher pour une session : surcharge custom si présente, sinon titre auto.
export function sessionTitle(s) {
  return (s && ui.names[s.id]) || (s && s.title) || '(untitled)';
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

// ─── Notifications navigateur ────────────────────────────────────────────────────────────────
// Notifie quand une session « a fini / attend ta réponse » : question en attente (hasQuestion),
// attention (permission), waiting (fin de tour, hook Stop), background (fin de tour + job de fond
// encore actif) ou ended (session terminée). Logique pure extraite dans ./notify.js (testable).
// On ne notifie que sur le FRONT MONTANT (changement d'état), jamais en rafale au chargement
// (1er passage = mémorisation seule).
const prevNotifyKey = new Map(); // sessionId → dernière clé notifiable connue
let notifySeeded = false;         // 1er passage : on mémorise l'état sans notifier
function notifyEnabled() {
  return ui.notify && typeof Notification !== 'undefined' && Notification.permission === 'granted';
}
function fireNotification(s, kind) {
  try {
    const n = new Notification(`${kind.icon} ${sessionTitle(s)}`, {
      body: `${s.projectName || 'session'} — ${kind.label}`,
      tag: 'hooked-session-' + s.id, // remplace la notif précédente de la même session
      renotify: true,
    });
    n.onclick = () => { try { window.focus(); location.assign('/session/' + encodeURIComponent(s.id)); } catch {} };
  } catch (_) {}
}
function checkNotifications(sessions) {
  const next = new Map();
  for (const s of sessions) next.set(s.id, notifyKeyFor(s));
  if (notifySeeded && ui.notify) {
    let pinged = false;
    for (const s of sessions) {
      if (ui.notifyPinnedOnly && !ui.pinned.includes(s.id)) continue;
      const key = next.get(s.id);
      if (key && key !== (prevNotifyKey.get(s.id) || '')) {
        if (notifyEnabled()) fireNotification(s, NOTIFY_KINDS[key]); // popup bureau natif (contexte sécurisé)
        pinged = true;
      }
    }
    if (pinged) playPing(); // son : repli qui marche partout (même http)
  }
  prevNotifyKey.clear();
  for (const [id, k] of next) prevNotifyKey.set(id, k);
  notifySeeded = true;
  applyTitleBadge(sessions); // badge d'onglet : repli qui marche partout
}

// ── Repli universel (sans contexte sécurisé) : badge dans le titre de l'onglet + bip audio.
// Les notifs natives exigent HTTPS/localhost ; ce repli garantit un signal quel que soit l'accès
// (IP LAN, MagicDNS, VPN… en HTTP). Le badge = nb de sessions qui t'attendent.
function applyTitleBadge(sessions = data.sessions) {
  if (typeof document === 'undefined') return;
  const base = '🪝 hooked';
  if (!ui.notify) { document.title = base; return; }
  const n = sessions.reduce((a, s) => {
    if (ui.notifyPinnedOnly && !ui.pinned.includes(s.id)) return a;
    return a + (countsForBadge(notifyKeyFor(s)) ? 1 : 0);
  }, 0);
  document.title = n > 0 ? `(${n}) 🔔 ${base}` : base;
}
let audioCtx = null;
function primeAudio() { // à appeler sur un geste utilisateur (déblocage de l'autoplay)
  try {
    if (typeof AudioContext === 'undefined') return;
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {}
}
function playPing() {
  try {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime;
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.26);
  } catch {}
}

// Active/désactive les notifications. Natif (popup bureau) si contexte sécurisé + permission ;
// sinon repli universel (badge d'onglet + son) qui marche partout, y compris en HTTP sur IP/LAN.
export function toggleNotifyPinnedOnly() {
  ui.notifyPinnedOnly = !ui.notifyPinnedOnly;
  applyTitleBadge();
}

export async function toggleNotify() {
  if (ui.notify) { ui.notify = false; applyTitleBadge(); return; }
  ui.notify = true;
  primeAudio(); // ce clic débloque l'audio (autoplay policy)
  const secure = typeof isSecureContext === 'undefined' ? true : isSecureContext;
  const nativeOk = typeof Notification !== 'undefined' && secure;
  if (nativeOk && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} }
  if (!(nativeOk && Notification.permission === 'granted')) {
    alert(`Notifications enabled in "fallback" mode: tab badge + sound (works everywhere, even over HTTP).\n\nNative desktop popups require a secure context — you're on ${location.origin}. Open the dashboard via HTTPS or http://localhost:4123 (same machine).`);
  }
  applyTitleBadge();
}

export async function loadSessions() {
  try {
    const sessions = await getSessions();
    data.sessions = sessions;
    checkNotifications(sessions);
  } catch (_) {}
}

// ─── Réglages persistants (settings.json côté serveur, partagés entre navigateurs) ───────────
// Miroir réactif du store serveur. Chargé au démarrage (startLive) ; la page Réglages édite via
// updateSettings (patch partiel → persiste → resync). Défauts alignés sur server/settings.js.
export const settings = $state({
  subtabOrder: ['chat', 'changes', 'todos', 'subagents', 'subsessions', 'background', 'terminal', 'pr', 'issues'],
  statusBarOrder: ['branch', 'stateBadge', 'permissionMode', 'modelEffort', 'cost', 'prompts', 'tokens', 'model', 'usage5h', 'prLinks', 'issueLinks', 'focusBtn'],
  subtabHidden: [],
  initialShellCommand: '',
  statusBar: {
    branch: true, stateBadge: true, permissionMode: true, modelEffort: true,
    cost: true, prompts: true, tokens: true, model: true, usage5h: true, prLinks: false, issueLinks: false, focusBtn: true,
  },
  defaultModel: '', defaultEffort: '', defaultMode: '',
});
export async function loadSettings() {
  try { Object.assign(settings, await getSettings()); } catch (_) {}
}
export async function updateSettings(patch) {
  const res = await apiSaveSettings(patch);
  if (res.ok && res.data.settings) Object.assign(settings, res.data.settings);
  return res;
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
  loadSettings();
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
