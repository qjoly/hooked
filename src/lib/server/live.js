// Flux temps réel (SSE). Singleton process : un seul jeu de watchers fs + un Set de
// clients SSE, partagés par toutes les requêtes /api/stream. Reprend la logique de
// l'ancien server.js (fs.watch HOOKED_DIR + PROJECTS_DIR récursif, débounce, heartbeat).
import fs from 'node:fs';
import { HOOKED_DIR, PROJECTS_DIR, onShutdown } from './core.js';

const encoder = new TextEncoder();
const TICK = encoder.encode('data: tick\n\n');

// globalThis : survit au rechargement de module (HMR/SSR de Vite en dev) → on ne
// recrée pas les watchers ni le Set de clients à chaque hot-reload.
const g = globalThis;
const state = (g.__hookedLive ??= { clients: new Set(), started: false, debounce: null, watchers: [] });

function broadcast() {
  for (const c of state.clients) {
    try { c.enqueue(TICK); } catch (_) { state.clients.delete(c); }
  }
}
// pousse à chaque écriture d'évènement de hook (débounce 250 ms) + heartbeat régulier
function pushSoon() {
  clearTimeout(state.debounce);
  state.debounce = setTimeout(broadcast, 250);
}

function ensureStarted() {
  if (state.started) return;
  state.started = true;
  try {
    fs.mkdirSync(HOOKED_DIR, { recursive: true });
    watch(HOOKED_DIR, {});
  } catch (_) {}
  // temps réel sur les updates de Claude : on observe l'arborescence des transcripts
  // (récursif — macOS/Windows) pour pousser dès qu'un message est écrit.
  watch(PROJECTS_DIR, { recursive: true });
  setInterval(broadcast, 4000).unref();
  // Ces watchers sont les DEUX handles qui retenaient le processus après un Ctrl+C : adapter-node
  // ferme le listener HTTP mais ne sort jamais, donc un handle non libéré fait vivre le processus
  // pour toujours. Ils sont unref() (comme le heartbeat juste au-dessus) et fermés à l'arrêt.
  onShutdown(stopLive);
}

// fs.watch gardé dans state.watchers et unref() : un watcher référencé retient la boucle
// d'évènements, et ce flux n'est jamais une raison de maintenir le processus en vie.
function watch(dir, opts) {
  try {
    const w = fs.watch(dir, opts, pushSoon);
    w.unref?.();
    state.watchers.push(w);
  } catch (_) {} // dossier absent → le heartbeat couvre
}

// Ferme les watchers et coupe les clients SSE. Sans fermer les clients, les connexions SSE ne
// drainent pas et adapter-node attend son SHUTDOWN_TIMEOUT (30 s) avant de fermer le serveur.
export function stopLive() {
  for (const w of state.watchers.splice(0)) { try { w.close(); } catch (_) {} }
  clearTimeout(state.debounce);
  for (const c of [...state.clients]) { try { c.close(); } catch (_) {} }
  state.clients.clear();
  state.started = false;
}

// Enregistre un client SSE (le controller d'un ReadableStream). Démarre les watchers
// au premier client. Renvoie une fonction de désinscription (appelée à la fermeture).
export function addClient(controller) {
  ensureStarted();
  state.clients.add(controller);
  return () => state.clients.delete(controller);
}
