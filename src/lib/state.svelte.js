// État partagé (runes Svelte 5). Un seul objet réactif partagé entre composants.
// La navigation (vue courante, session ouverte, écran « nouvelle session ») n'est PLUS
// ici : elle est portée par l'URL (routing SvelteKit). Ne restent que les filtres de la
// sidebar, l'état live (SSE), le tick de rafraîchissement et la modale.
import { getSessions, connectSSE, getSettings, saveSettings as apiSaveSettings, getTags, saveTags, replaceTags, getSessionMeta, saveSessionMeta, replaceSessionMeta, kill } from './api.js';
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
  tags: {},                             // { [sessionId]: [tag] } → miroir réactif du store serveur (tags.json), chargé au démarrage
  meta: {},                             // { [sessionId]: { archived?, snoozeUntil? } } → miroir réactif du store serveur (session-meta.json)
  focus: persisted.focus ?? false,      // mode focus : discussion plein écran (header global + sidebar repliés)
  sidebarPeek: false,                   // (transitoire) ré-ouverture ponctuelle de la sidebar pendant le focus
  splitCompact: false,                  // (transitoire) split trop étroit → masque les menus latéraux
  toolsOpen: false,                     // (transitoire, off au chargement) déplie l'input/result de tous les outils
  modal: null,               // { type, data } | null
  tick: 0,                   // incrémenté à chaque évènement live → relance les effets
  theme: readTheme(),        // 'system' | 'light' | 'dark' (persisté à part, cf. app.html)
  scheme: readScheme(),      // 'default' | 'legacy' — palette (color-scheme), axe orthogonal au clair/sombre
  corners: readCorners(),    // 'round' | 'sharp' — forme des angles, 3e axe orthogonal
  notify: persisted.notify ?? false,    // notifications navigateur (session finie / en attente de toi)
  notifyPinnedOnly: persisted.notifyPinnedOnly ?? false, // if true: only notify for pinned sessions
  diffSplit: persisted.diffSplit ?? false, // render conversation diffs side-by-side (split) instead of unified
  groupByProject: persisted.groupByProject ?? true, // sidebar: regroupe les sessions par projet (dépôt/dossier) au lieu des sections de statut
  sideMenuOpen: persisted.sideMenuOpen ?? true,     // side menu gauche (liste sessions) déplié ? persisté
  sidebarWidth: persisted.sidebarWidth ?? 232,      // largeur (px) du side panel gauche déplié, persistée
  dockWidth: persisted.dockWidth ?? 292,            // largeur (px) du dock droit (lentille Converse), persistée
  termHeight: persisted.termHeight ?? 0,            // hauteur (px) du panneau terminal bas ; 0 = défaut (1/3 de fenêtre)            // largeur (px) du dock droit (lentille Converse), persistée
  dockHidden: persisted.dockHidden ?? false,        // dock droit masqué par l'utilisateur ? persisté
  lastSessionId: persisted.lastSessionId ?? null,   // dernière session ouverte — l'onglet Sessions y revient
  collapseWorktrees: persisted.collapseWorktrees ?? true, // new-session: replie les worktrees `.claude/worktrees/*` sur leur projet parent dans le sélecteur
  shipFilesWidth: persisted.shipFilesWidth ?? 232,  // largeur (px) du rail « Files » de la lentille Ship, persistée
  shipPanelWidth: persisted.shipPanelWidth ?? 288,  // largeur (px) du panneau « Ready to ship » de la lentille Ship, persistée
});

if (typeof localStorage !== 'undefined') {
  $effect.root(() => {
    $effect(() => {
      const snapshot = { hideOld: ui.hideOld, collapsed: ui.collapsed, pinned: ui.pinned, names: ui.names, focus: ui.focus, notify: ui.notify, notifyPinnedOnly: ui.notifyPinnedOnly, diffSplit: ui.diffSplit, groupByProject: ui.groupByProject, sideMenuOpen: ui.sideMenuOpen, sidebarWidth: ui.sidebarWidth, dockWidth: ui.dockWidth, dockHidden: ui.dockHidden, lastSessionId: ui.lastSessionId, termHeight: ui.termHeight, collapseWorktrees: ui.collapseWorktrees, shipFilesWidth: ui.shipFilesWidth, shipPanelWidth: ui.shipPanelWidth };
      try { localStorage.setItem(LS_KEY, JSON.stringify(snapshot)); } catch {}
    });
  });
}

// épingle / désépingle une session (toggle). Persisté via l'effet ci-dessus.
export function togglePin(id) {
  ui.pinned = ui.pinned.includes(id) ? ui.pinned.filter((x) => x !== id) : [...ui.pinned, id];
}

// ─── Per-session Deck metadata (session-meta.json server-side, shared across browsers) ───────
// Archived flag + snooze deadline live in a server store mirrored in ui.meta (same scheme as
// tags): optimistic local update, then persistence — the server re-normalizes and is the
// source of truth (it prunes expired snoozes and empty entries).
function patchMeta(id, patch) {
  const merged = { ...(ui.meta[id] || {}), ...patch };
  if (merged.archived !== true) delete merged.archived;
  if (!(merged.snoozeUntil > Date.now())) delete merged.snoozeUntil;
  const next = { ...ui.meta };
  if (Object.keys(merged).length) next[id] = merged;
  else delete next[id];
  ui.meta = next;
  saveSessionMeta(id, patch).then((res) => { if (res.ok && res.data.meta) ui.meta = res.data.meta; }).catch(() => {});
}
// archive / unarchive a session (toggle). An archived session is hidden from the Deck
// (decision queue + fleet) by default; reversible. Archiving ALSO stops the underlying
// session — the old stop/archive distinction is gone: archiving IS the "done, shut it down"
// action. Unarchiving only flips the flag (a stopped session is restarted via Resume, not here).
export function toggleArchive(id) {
  const willArchive = !isArchived(id);
  patchMeta(id, { archived: willArchive });
  if (willArchive) kill(id).catch(() => {});
}
export function isArchived(id) { return !!(ui.meta[id] && ui.meta[id].archived); }
// remove the archived flag WITHOUT stopping anything — used when RELAUNCHING an archived session
// (resume): bringing it back to life should also bring it back into the live fleet. No-op if the
// session isn't archived.
export function unarchive(id) { if (isArchived(id)) patchMeta(id, { archived: false }); }
// "Effectively archived" for the Deck/fleet: explicitly archived OR a finished session
// (ended / past) — finished sessions are treated as archived (hidden from the live fleet,
// collected in the Archived section). Takes the session object (needs its state).
export function isSessionArchived(s) {
  return !!s && (isArchived(s.id) || s.state === 'ended' || s.state === 'past');
}
// snooze a session's decision card for N hours (Deck). Cleared by passing 0/negative hours.
export function snoozeSession(id, hours = 1) {
  patchMeta(id, { snoozeUntil: hours > 0 ? Date.now() + hours * 3600_000 : null });
}
// epoch ms until which the session's decision is snoozed (0 when not snoozed).
export function snoozeUntil(id) { return (ui.meta[id] && ui.meta[id].snoozeUntil) || 0; }

// ─── Split view (VS Code / Arc style grid, in the normal session view) ────────────────────────
// The /session/<id> workspace tiles sessions in a 2D grid: COLUMNS laid out horizontally, each
// column stacking one or more ROWS (panes) vertically → both horizontal AND vertical splits.
// Shape: split.cols = [ { w, rows: [ { id, h } ] } ]. `w`/`h` are flex-grow ratios (resizable);
// `id` is the session shown (null = empty pane → picker). The ANCHOR pane (col 0, row 0) always
// mirrors the route session (see `anchorSplit`). Persisted across reloads (localStorage).
const MAX_COLS = 3;      // horizontal splits
const MAX_ROWS = 3;      // vertical splits per column
const MAX_PANES = 4;     // total panes (keeps each usable)
function freshGrid() { return { cols: [{ w: 1, rows: [{ id: null, h: 1 }] }] }; }
const splitPersisted = (() => {
  if (typeof localStorage === 'undefined') return null;
  try {
    const g = JSON.parse(localStorage.getItem('hooked.split') || 'null');
    if (g && Array.isArray(g.cols) && g.cols.length && g.cols.every((c) => Array.isArray(c.rows) && c.rows.length)) return g;
  } catch {}
  return null;
})();
export const split = $state(splitPersisted || freshGrid());
if (typeof localStorage !== 'undefined') {
  $effect.root(() => {
    $effect(() => { try { localStorage.setItem('hooked.split', JSON.stringify({ cols: split.cols })); } catch {} });
  });
}

// total panes across the grid.
export function paneCount() { return split.cols.reduce((n, c) => n + c.rows.length, 0); }
export function canSplit() { return paneCount() < MAX_PANES; }
// flat list of every pane with its grid coordinates — [{ id, col, row }].
export function splitPanes() {
  const out = [];
  split.cols.forEach((c, col) => c.rows.forEach((r, row) => out.push({ id: r.id, col, row })));
  return out;
}
// the anchor pane (col 0, row 0) is bound to the route: force it to `primary` on navigation.
export function anchorSplit(primary) {
  if (!split.cols.length) split.cols = freshGrid().cols;
  if (!split.cols[0].rows.length) split.cols[0].rows = [{ id: primary, h: 1 }];
  if (split.cols[0].rows[0].id !== primary) split.cols[0].rows[0] = { ...split.cols[0].rows[0], id: primary };
}
// most-recently-active OTHER session not already in the grid (fills a fresh pane).
function pickCandidate() {
  const used = new Set(splitPanes().map((p) => p.id));
  const cand = data.sessions
    .filter((s) => !used.has(s.id) && !isSessionArchived(s))
    .sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  return cand[0]?.id ?? null;
}
// add a new COLUMN to the right, seeded with the most-recent free session.
export function splitRight() {
  if (split.cols.length >= MAX_COLS || paneCount() >= MAX_PANES) return;
  split.cols = [...split.cols, { w: 1, rows: [{ id: pickCandidate(), h: 1 }] }];
}
// add a ROW below inside a given column (vertical split).
export function splitDown(col) {
  const c = split.cols[col];
  if (!c || c.rows.length >= MAX_ROWS || paneCount() >= MAX_PANES) return;
  const rows = [...c.rows, { id: pickCandidate(), h: 1 }];
  split.cols = split.cols.map((x, i) => (i === col ? { ...x, rows } : x));
}
// open a new pane (column to the right) showing a SPECIFIC session — the sidebar's "split beside".
export function addSplit(id) {
  if (!id || !canSplit() || split.cols.length >= MAX_COLS || isInSplit(id)) return;
  split.cols = [...split.cols, { w: 1, rows: [{ id, h: 1 }] }];
}
// change which session lives in a pane (per-pane picker). Anchor changes are handled by the route.
export function setPaneSession(col, row, id) {
  const c = split.cols[col];
  if (!c || !c.rows[row]) return;
  const rows = c.rows.map((r, i) => (i === row ? { ...r, id } : r));
  split.cols = split.cols.map((x, i) => (i === col ? { ...x, rows } : x));
}
// close a pane; empties collapse the column. The anchor (0,0) can never be closed.
export function closePane(col, row) {
  if (col === 0 && row === 0) return;
  const c = split.cols[col];
  if (!c) return;
  const rows = c.rows.filter((_, i) => i !== row);
  if (rows.length) split.cols = split.cols.map((x, i) => (i === col ? { ...x, rows } : x));
  else split.cols = split.cols.filter((_, i) => i !== col);
}
// collapse the whole split back to just the anchor.
export function clearSplit() { split.cols = [{ w: 1, rows: [{ id: split.cols[0]?.rows[0]?.id ?? null, h: 1 }] }]; }
export function isSplit() { return paneCount() > 1; }
export function isInSplit(id) { return splitPanes().some((p) => p.id === id); }
// Split the current session with the most-recently-active OTHER session (header button + shortcut):
// opens one more pane to the right. No-op if there's no candidate or we're at the pane cap.
export function splitWithMostRecent(currentId) {
  if (!canSplit()) return;
  if (pickCandidate()) splitRight();
}

// renomme une session (titre custom local, persisté comme les pins). Vide/blanc → on retire
// la surcharge et on retombe sur le titre auto (1er prompt / ai-title du transcript).
export function renameSession(id, name) {
  const next = { ...ui.names };
  if (name && name.trim()) next[id] = name.trim().slice(0, 120);
  else delete next[id];
  ui.names = next;
}

// tags d'une session (tableau, jamais null). Miroir du store serveur (tags.json).
export function sessionTags(id) {
  return ui.tags[id] || [];
}
// remplace les tags d'une session (dédupliqués, rognés). Liste vide → on retire l'entrée.
// Mise à jour optimiste du miroir local + persistance serveur (le serveur re-normalise et fait foi).
export function setSessionTags(id, list) {
  const clean = [...new Set(list.map((t) => t.trim()).filter(Boolean).map((t) => t.slice(0, 40)))];
  const next = { ...ui.tags };
  if (clean.length) next[id] = clean;
  else delete next[id];
  ui.tags = next;
  saveTags(id, clean).then((res) => { if (res.ok && res.data.tags) ui.tags = res.data.tags; }).catch(() => {});
}
// tous les tags en usage (triés, uniques) — alimente la barre de filtres.
export function allTags() {
  return [...new Set(Object.values(ui.tags).flat())].sort((a, b) => a.localeCompare(b));
}
// nombre de sessions portant un tag donné.
export function tagUsage(tag) {
  return Object.values(ui.tags).filter((list) => list.includes(tag)).length;
}
// supprime un tag globalement (retiré de toutes les sessions) — les tags n'ont pas
// d'existence propre, ils vivent via les sessions. Retire aussi le tag des filtres actifs.
// Mise à jour optimiste du miroir local + persistance serveur (le serveur re-normalise et fait foi).
export function deleteTag(tag) {
  const next = {};
  for (const [id, list] of Object.entries(ui.tags)) {
    const kept = list.filter((t) => t !== tag);
    if (kept.length) next[id] = kept;
  }
  ui.tags = next;
  ui.tagFilters = ui.tagFilters.filter((t) => t !== tag);
  replaceTags(next).then((res) => { if (res.ok && res.data.tags) ui.tags = res.data.tags; }).catch(() => {});
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

// ─── Color scheme (palette : default / legacy) ──────────────────────────────────────────────
// Axe ORTHOGONAL au clair/sombre : on choisit la palette, le clair/sombre reste géré par `theme`.
// Persisté sous 'hooked.scheme', relu par le script anti-FOUC de app.html.
// 'default' (défaut) = aucun data-scheme → palette indigo de la refonte ;
// 'legacy' = data-scheme="legacy" → ancien thème crème/terracotta ;
// 'datadog' = data-scheme="datadog" → violet Datadog, surfaces froides, densité d'outil.
const SCHEME_KEY = 'hooked.scheme';
const SCHEME_ORDER = ['default', 'legacy', 'datadog'];
function readScheme() {
  if (typeof localStorage === 'undefined') return 'default';
  try { const s = localStorage.getItem(SCHEME_KEY); return SCHEME_ORDER.includes(s) ? s : 'default'; }
  catch { return 'default'; }
}
// pose (ou retire) l'attribut data-scheme sur <html> selon le choix courant.
function applyScheme() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (ui.scheme !== 'default') root.setAttribute('data-scheme', ui.scheme);
  else root.removeAttribute('data-scheme'); // 'default' → aucun attribut, palette de base
}
export function setScheme(s) {
  ui.scheme = SCHEME_ORDER.includes(s) ? s : 'default';
  try { localStorage.setItem(SCHEME_KEY, ui.scheme); } catch {}
  applyScheme();
}
// cycle default → legacy → datadog → default…
export function cycleScheme() {
  setScheme(SCHEME_ORDER[(SCHEME_ORDER.indexOf(ui.scheme) + 1) % SCHEME_ORDER.length]);
}

// ─── Corners (arrondis : round / sharp) ──────────────────────────────────────────────────────
// TROISIÈME axe orthogonal, indépendant du clair/sombre ET de la palette : la forme des angles.
// 'round' (défaut) = aucun attribut ; 'sharp' = data-corners="sharp" → tout à angle vif (cf. la
// règle unique dans app.css). Séparé de `scheme` à dessein : `scheme` choisit des COULEURS, et on
// veut pouvoir prendre les angles vifs avec n'importe quelle palette.
const CORNERS_KEY = 'hooked.corners';
const CORNERS_ORDER = ['round', 'sharp'];
function readCorners() {
  if (typeof localStorage === 'undefined') return 'round';
  try { const c = localStorage.getItem(CORNERS_KEY); return CORNERS_ORDER.includes(c) ? c : 'round'; }
  catch { return 'round'; }
}
function applyCorners() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (ui.corners === 'sharp') root.setAttribute('data-corners', ui.corners);
  else root.removeAttribute('data-corners'); // 'round' → aucun attribut, arrondis d'origine
}
export function setCorners(c) {
  ui.corners = CORNERS_ORDER.includes(c) ? c : 'round';
  try { localStorage.setItem(CORNERS_KEY, ui.corners); } catch {}
  applyCorners();
}
// cycle round → sharp → round…
export function cycleCorners() {
  setCorners(CORNERS_ORDER[(CORNERS_ORDER.indexOf(ui.corners) + 1) % CORNERS_ORDER.length]);
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
    if (snoozeUntil(s.id) > Date.now()) return a; // session snoozée depuis le Deck → pas de badge
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
  remoteControlProjects: [],
  favoriteProjects: [],
  digest: { auto: true, hour: 7, model: '' },
  editor: 'vscode', // éditeur préféré (clé de src/lib/editors.js) pour les liens « open in editor »
  shipDefaultView: 'claude', // source de diff à l'ouverture de la lentille Ship ('claude' | 'vcs')
  defaultPage: 'deck',
  navTabs: ['sessions', 'search', 'stats', 'digest', 'memory', 'mcp'], // onglets de nav visibles (paramétrable)
});
export async function loadSettings() {
  try { Object.assign(settings, await getSettings()); } catch (_) {}
}
export async function updateSettings(patch) {
  const res = await apiSaveSettings(patch);
  if (res.ok && res.data.settings) Object.assign(settings, res.data.settings);
  return res;
}

// ─── Étiquettes de session (tags.json côté serveur, partagées entre navigateurs) ──────────────
// Chargé au démarrage (startLive). Les tags vivaient autrefois dans localStorage ('hooked.ui') ;
// au 1er chargement où le store serveur est vide, on migre une fois les tags locaux historiques.
export async function loadTags() {
  try {
    const res = await getTags();
    let server = res.tags || {};
    if (!Object.keys(server).length && persisted.tags && Object.keys(persisted.tags).length) {
      const r = await replaceTags(persisted.tags);
      if (r.ok && r.data.tags) server = r.data.tags;
    }
    ui.tags = server;
  } catch (_) {}
}

// ─── Per-session Deck metadata (session-meta.json server-side) ────────────────────────────────
// Loaded at startup (startLive). Archived ids used to live in localStorage ('hooked.ui'.archived)
// and snoozes in 'hooked.snooze'; on the first load where the server store is empty, the
// historical local state is migrated once (same scheme as tags).
export async function loadSessionMeta() {
  try {
    const res = await getSessionMeta();
    let server = res.meta || {};
    if (!Object.keys(server).length) {
      const legacy = {};
      for (const id of Array.isArray(persisted.archived) ? persisted.archived : []) {
        if (typeof id === 'string' && id) legacy[id] = { archived: true };
      }
      try {
        const snooze = JSON.parse(localStorage.getItem('hooked.snooze') || '{}') || {};
        for (const [id, until] of Object.entries(snooze)) {
          if (until > Date.now()) legacy[id] = { ...legacy[id], snoozeUntil: until };
        }
      } catch {}
      if (Object.keys(legacy).length) {
        const r = await replaceSessionMeta(legacy);
        if (r.ok && r.data.meta) server = r.data.meta;
      }
    }
    ui.meta = server;
  } catch (_) {}
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
  // 1er chargement immédiat. On marque « chargé maintenant » AVANT le fetch (pas dans le .then) :
  // sinon lastLoadAt reste à 0 pendant ~550 ms et la RAFALE de ticks SSE au connect passe sous le
  // plancher de 250 ms → un 2e /api/sessions part en concurrence du 1er. En le posant tout de suite,
  // le throttle (1 s) absorbe la rafale de connect → un seul chargement au démarrage.
  lastLoadAt = Date.now();
  loadSessions();
  loadSettings();
  loadTags();
  loadSessionMeta();
  appVersion().then((v) => { loadedVersion = v; }); // version de référence (au chargement)
  connectSSE({
    onOpen: async () => {
      ui.live = true;
      // reconnexion : si le build du front a changé (service redéployé), on recharge la page
      // pour servir la nouvelle version. Pas de reload au 1er connect (loadedVersion = la même).
      if (loadedVersion) { const v = await appVersion(); if (v && v !== loadedVersion) location.reload(); }
    },
    onError: () => { ui.live = false; },
    onTick: scheduleRefresh,
  });
  // filet : rafraîchit la liste régulièrement même sans évènement
  setInterval(scheduleRefresh, 5000);
}

// Coalescing + throttle des refetch. Une rafale de ticks SSE (surtout le rejeu au CONNECT) se
// réduit à UN seul /api/sessions au lieu de 3-4 : trailing-debounce (les ticks rapprochés sont
// absorbés) + intervalle minimum entre deux chargements. Le live tolère très bien ~250 ms de
// latence sur une mise à jour ; ça supprime le pic de requêtes au premier chargement.
let refreshTimer = null;
let lastLoadAt = 0;
const REFRESH_DEBOUNCE = 250;   // ms : fenêtre d'absorption des ticks rapprochés
const REFRESH_MIN_GAP = 1000;   // ms : jamais plus d'un /api/sessions par seconde
function scheduleRefresh() {
  if (refreshTimer) return; // un refetch est déjà programmé → tick intermédiaire absorbé
  const wait = Math.max(REFRESH_DEBOUNCE, REFRESH_MIN_GAP - (Date.now() - lastLoadAt));
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, wait);
}

async function refresh() {
  lastLoadAt = Date.now();
  await loadSessions();
  ui.tick++; // signale aux effets (détail de session ouvert, vue d'ensemble…) de se réévaluer
}

export const openModal = (type, data2) => { ui.modal = { type, data: data2 }; };
export const closeModal = () => { ui.modal = null; };
