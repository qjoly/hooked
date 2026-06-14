'use strict';
/*
 * Évènements live (écrits par hook.js dans events.jsonl) + config de lancement
 * (launches.jsonl). Caches invalidés par mtime/size du fichier.
 */
const fs = require('fs');
const { EVENTS_FILE, LAUNCHES_FILE } = require('./config');
const { statSafe } = require('./util');

let eventsCache = { key: null, list: [] };
function readEvents(eventsFile = EVENTS_FILE) {
  const st = statSafe(eventsFile);
  if (!st) return [];
  const key = st.mtimeMs + ':' + st.size;
  if (eventsCache.key === key) return eventsCache.list;
  let data;
  try { data = fs.readFileSync(eventsFile, 'utf8'); } catch (_) { return eventsCache.list; }
  const lines = data.split('\n').filter(Boolean);
  const list = [];
  for (const l of lines.slice(-8000)) {
    try { list.push(JSON.parse(l)); } catch (_) {}
  }
  eventsCache = { key, list };
  return list;
}

function lastEventBySession(eventsFile = EVENTS_FILE) {
  const ev = readEvents(eventsFile);
  const map = new Map();
  for (const e of ev) {
    if (!e.session_id) continue;
    map.set(e.session_id, e);
  }
  return map;
}

// dernier pane tmux connu pour une session (parcourt les évènements à rebours).
function paneForSession(id, eventsFile = EVENTS_FILE) {
  const ev = readEvents(eventsFile);
  for (let i = ev.length - 1; i >= 0; i--) {
    if (ev[i].session_id === id && ev[i].tmux_pane) return ev[i].tmux_pane;
  }
  return null;
}

// dernier mode de permission connu pour une session (default / acceptEdits / plan / bypassPermissions).
// Les payloads de hooks portent `permission_mode` (capté par hook.js) → on lit le plus récent.
function modeForSession(id, eventsFile = EVENTS_FILE) {
  const ev = readEvents(eventsFile);
  for (let i = ev.length - 1; i >= 0; i--) {
    if (ev[i].session_id === id && ev[i].mode) return ev[i].mode;
  }
  return null;
}

// Question AskUserQuestion *en attente* pour une session, reconstruite depuis les évènements live.
// Indispensable car le tool_use n'est écrit dans le transcript qu'une fois la question répondue.
function liveQuestionForSession(id, eventsFile = EVENTS_FILE) {
  const ev = readEvents(eventsFile);
  let pending = null;
  for (const e of ev) {
    if (e.session_id !== id) continue;
    if (e.event === 'PreToolUse' && e.tool === 'AskUserQuestion' && Array.isArray(e.ask) && e.ask.length) {
      pending = { id: 'live:' + e.ts, questions: e.ask };
    } else if ((e.event === 'PostToolUse' && e.tool === 'AskUserQuestion') || e.event === 'Stop' || e.event === 'SubagentStop' || e.event === 'SessionEnd' || e.event === 'UserPromptSubmit') {
      pending = null;
    }
  }
  return pending;
}

// Métadonnées des sessions vues dans les évènements (cwd, transcript, timestamps).
// Permet de faire apparaître une session DÈS son premier hook (SessionStart /
// UserPromptSubmit), avant que Claude Code n'ait écrit le transcript — sinon la
// session reste invisible dans la sidebar jusqu'au premier message de l'assistant.
function eventSessionMeta(eventsFile = EVENTS_FILE) {
  const ev = readEvents(eventsFile);
  const map = new Map();
  for (const e of ev) {
    if (!e.session_id) continue;
    const m = map.get(e.session_id) || { cwd: null, transcript: null, firstTs: null, lastTs: null, ended: false, firstPrompt: null };
    if (e.cwd && !m.cwd) m.cwd = e.cwd;
    if (e.transcript && !m.transcript) m.transcript = e.transcript;
    if (e.event === 'UserPromptSubmit' && e.prompt && !m.firstPrompt) m.firstPrompt = e.prompt;
    if (e.ts) {
      if (!m.firstTs || e.ts < m.firstTs) m.firstTs = e.ts;
      if (!m.lastTs || e.ts > m.lastTs) m.lastTs = e.ts;
    }
    if (e.event === 'SessionEnd') m.ended = true;
    map.set(e.session_id, m);
  }
  return map;
}

// config de lancement (modèle/effort) par nom de session tmux ; dernier write gagne.
let launchCache = { key: null, map: new Map() };
function launchConfigByTmux(launchesFile = LAUNCHES_FILE) {
  const st = statSafe(launchesFile);
  if (!st) return launchCache.map;
  const key = st.mtimeMs + ':' + st.size;
  if (launchCache.key === key) return launchCache.map;
  const map = new Map();
  let data = '';
  try { data = fs.readFileSync(launchesFile, 'utf8'); } catch (_) { return launchCache.map; }
  for (const line of data.split('\n')) {
    if (!line) continue;
    try { const j = JSON.parse(line); if (j.tmux) map.set(j.tmux, { model: j.model || null, effort: j.effort || null }); } catch (_) {}
  }
  launchCache = { key, map };
  return map;
}

module.exports = { readEvents, lastEventBySession, paneForSession, modeForSession, liveQuestionForSession, launchConfigByTmux, eventSessionMeta };
