// Flux temps réel (SSE). Singleton process : un seul jeu de watchers fs + un Set de
// clients SSE, partagés par toutes les requêtes /api/stream. Reprend la logique de
// l'ancien server.js (fs.watch HOOKED_DIR + PROJECTS_DIR récursif, débounce, heartbeat).
import fs from 'node:fs';
import { HOOKED_DIR, PROJECTS_DIR } from './core.js';

const encoder = new TextEncoder();
const TICK = encoder.encode('data: tick\n\n');

// globalThis : survit au rechargement de module (HMR/SSR de Vite en dev) → on ne
// recrée pas les watchers ni le Set de clients à chaque hot-reload.
const g = globalThis;
const state = (g.__hookedLive ??= { clients: new Set(), started: false, debounce: null });

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
    fs.watch(HOOKED_DIR, pushSoon);
  } catch (_) {}
  // temps réel sur les updates de Claude : on observe l'arborescence des transcripts
  // (récursif — macOS/Windows) pour pousser dès qu'un message est écrit.
  try {
    fs.watch(PROJECTS_DIR, { recursive: true }, pushSoon);
  } catch (_) {}
  setInterval(broadcast, 4000).unref();
}

// Enregistre un client SSE (le controller d'un ReadableStream). Démarre les watchers
// au premier client. Renvoie une fonction de désinscription (appelée à la fermeture).
export function addClient(controller) {
  ensureStarted();
  state.clients.add(controller);
  return () => state.clients.delete(controller);
}
