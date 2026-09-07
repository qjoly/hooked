/*
 * Évènements live (écrits par hook.cjs dans events.jsonl). Caches invalidés par mtime/size du
 * fichier. Les hooks globaux (~/.claude/settings.json) s'exécutent aussi pour les sessions pilotées
 * par l'Agent SDK (`settingSources` par défaut = toutes les sources) : c'est ce qui garde cette
 * couche intacte après la migration hors tmux — questions/plans en attente, todos, jobs de fond,
 * statusline continuent d'arriver par le même chemin, pour les sessions de hooked comme pour celles
 * qu'un utilisateur ouvre à la main dans un terminal.
 */
import fs from 'node:fs';
import { EVENTS_FILE } from './config.js';
import { statSafe } from './util.js';

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

// dernier mode de permission connu pour une session (default / acceptEdits / plan / bypassPermissions).
// Les payloads de hooks portent `permission_mode` (capté par hook.js) → on lit le plus récent.
function modeForSession(id, eventsFile = EVENTS_FILE) {
  const ev = readEvents(eventsFile);
  for (let i = ev.length - 1; i >= 0; i--) {
    if (ev[i].session_id === id && ev[i].mode) return ev[i].mode;
  }
  return null;
}

// État « question en attente » d'une session après un évènement : l'objet question (PreToolUse
// AskUserQuestion), null (l'évènement clôt l'attente : réponse / Stop / fin / nouveau prompt), ou
// `cur` inchangé (évènement neutre). Partagé par la vue par-id et la vue par-session (une passe).
function questionStep(cur, e) {
  if (e.event === 'PreToolUse' && e.tool === 'AskUserQuestion' && Array.isArray(e.ask) && e.ask.length) {
    return { id: 'live:' + e.ts, questions: e.ask };
  }
  if ((e.event === 'PostToolUse' && e.tool === 'AskUserQuestion') || e.event === 'Stop' || e.event === 'SubagentStop' || e.event === 'SessionEnd' || e.event === 'UserPromptSubmit') {
    return null;
  }
  return cur;
}

// Question AskUserQuestion *en attente* pour une session, reconstruite depuis les évènements live.
// Indispensable car le tool_use n'est écrit dans le transcript qu'une fois la question répondue.
function liveQuestionForSession(id, eventsFile = EVENTS_FILE) {
  const ev = readEvents(eventsFile);
  let pending = null;
  for (const e of ev) { if (e.session_id === id) pending = questionStep(pending, e); }
  return pending;
}

// map session_id -> question en attente, en UNE passe (vs liveQuestionForSession par session, qui
// rebalayait les ~8000 évènements pour CHAQUE session à chaque poll — O(sessions × évènements)).
function liveQuestionBySession(eventsFile = EVENTS_FILE) {
  const ev = readEvents(eventsFile);
  const map = new Map();
  for (const e of ev) { if (e.session_id) map.set(e.session_id, questionStep(map.get(e.session_id) || null, e)); }
  return map;
}

// État « plan en attente » d'une session après un évènement (même forme que questionStep). NB : à
// la différence de la question, SubagentStop ne clôt PAS un plan (seul l'agent principal approuve).
function planStep(cur, e) {
  if (e.event === 'PreToolUse' && e.tool === 'ExitPlanMode' && typeof e.plan === 'string' && e.plan) {
    return { id: 'live:' + e.ts, ts: e.ts, plan: e.plan };
  }
  if ((e.event === 'PostToolUse' && e.tool === 'ExitPlanMode') || e.event === 'Stop' || e.event === 'SessionEnd' || e.event === 'UserPromptSubmit') {
    return null;
  }
  return cur;
}

// Plan en attente d'approbation (ExitPlanMode) : posé au PreToolUse, levé quand le plan est
// résolu (PostToolUse ExitPlanMode = approuvé/rejeté), ou par un Stop / une fin de session / un
// nouveau prompt. `plan` (markdown) n'est présent que sur les events émis après l'ajout du hook.
function livePlanForSession(id, eventsFile = EVENTS_FILE) {
  const ev = readEvents(eventsFile);
  let pending = null;
  for (const e of ev) { if (e.session_id === id) pending = planStep(pending, e); }
  return pending;
}

// map session_id -> plan en attente, en UNE passe (vs livePlanForSession par session).
function livePlanBySession(eventsFile = EVENTS_FILE) {
  const ev = readEvents(eventsFile);
  const map = new Map();
  for (const e of ev) { if (e.session_id) map.set(e.session_id, planStep(map.get(e.session_id) || null, e)); }
  return map;
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

// Sessions appartenant à un démon remote-control : hooked lance ces process avec HOOKED_RC=1 dans
// leur environnement, que hook.cjs recopie en `rc: true` sur chaque évènement. C'est ce qui remplace
// l'ancienne reconnaissance par le nom de la session tmux (`hooked-rc-*`) : elles restent masquées de
// la sidebar (c'est de l'infra, pas des sessions qu'on pilote).
function rcSessionIdsFromEvents(eventsFile = EVENTS_FILE) {
  const set = new Set();
  for (const e of readEvents(eventsFile)) if (e.rc && e.session_id) set.add(e.session_id);
  return set;
}

export { readEvents, lastEventBySession, modeForSession, liveQuestionForSession, liveQuestionBySession, livePlanForSession, livePlanBySession, eventSessionMeta, rcSessionIdsFromEvents };
