/*
 * Agrégations de haut niveau : liste des sessions enrichie de l'état live (buildSessions),
 * statistiques d'usage (buildStats) et détail complet d'une session (sessionDetail).
 */
import path from 'node:path';
import { statSafe } from './util.js';
import { scanSessions, blankSummary } from './transcript.js';
import { readEvents, lastEventBySession, paneForSession, modeForSession, liveQuestionForSession, eventSessionMeta } from './events.js';
import { liveStateFor } from './live.js';
import { resolveLaunchForSession, paneTmuxNames, tmuxAlive, readPaneModeSync } from './tmux.js';
import { usageWindow } from './usage.js';
import { sessionStatus, sessionStatusRaw } from './status.js';
import { buildConversation } from './conversation.js';
import { buildFileChanges } from './changes.js';
import { buildSubagents } from './subagents.js';
import { latestTodos, todoSummary } from './todos.js';

// Sessions « live-only » : présentes dans les évènements de hooks mais pas encore
// dans un transcript (Claude Code n'écrit le .jsonl qu'au premier message de
// l'assistant). On les synthétise pour qu'elles apparaissent dès le lancement.
// Garde-fou : seulement les sessions récentes, non terminées, sans transcript sur disque
// (sinon scanSessions les aurait déjà ; un transcript supprimé reste donc masqué).
const EVENT_SESSION_MAX_AGE_MIN = 30;
function eventOnlySessions(knownIds, now = Date.now()) {
  const out = [];
  for (const [id, m] of eventSessionMeta()) {
    if (knownIds.has(id) || m.ended) continue;
    if (m.transcript && statSafe(m.transcript)) continue; // transcript écrit → géré par scanSessions
    if (!m.lastTs || (now - Date.parse(m.lastTs)) / 60000 > EVENT_SESSION_MAX_AGE_MIN) continue;
    const s = blankSummary(id, m.transcript || null);
    if (m.cwd) { s.project = m.cwd; s.projectName = path.basename(m.cwd); }
    s.startTs = m.firstTs;
    s.lastTs = m.lastTs;
    // titre : 50 premiers caractères du prompt utilisateur (capté par le hook), sinon placeholder.
    if (m.firstPrompt) { s.firstPrompt = m.firstPrompt; s.title = m.firstPrompt.slice(0, 50); }
    else s.title = '(nouvelle session)';
    out.push(s);
  }
  return out;
}

function buildSessions() {
  const sessions = scanSessions();
  const known = new Set(sessions.map((s) => s.id));
  sessions.push(...eventOnlySessions(known));
  const last = lastEventBySession();
  const now = Date.now();
  for (const s of sessions) {
    const ev = last.get(s.id);
    s.tmuxPane = (ev && ev.tmux_pane) || paneForSession(s.id);
    const live = liveStateFor(ev);
    if (live) {
      s.state = live.state;
      s.currentTool = live.tool;
      s.liveTs = ev.ts;
    } else {
      const ageMin = s.lastTs ? (now - Date.parse(s.lastTs)) / 60000 : Infinity;
      s.state = ageMin < 3 ? 'working' : 'past';
      s.currentTool = null;
      s.liveTs = null;
    }
    s.lastActivity = s.liveTs && (!s.lastTs || s.liveTs > s.lastTs) ? s.liveTs : s.lastTs;
    // le pane n'existe peut-être plus (tmux fermé) → on distingue « live » de « dernier connu »
    s.tmuxAlive = tmuxAlive(s.tmuxPane);
    // effort : vrai effort de la statusline (toutes sessions) en priorité, sinon résolution
    // persistée du lancement hooked (survit à la mort du tmux). modèle explicite idem.
    const li = resolveLaunchForSession(s.id);
    const raw = sessionStatusRaw(s.id);
    s.effort = (raw && raw.effort && raw.effort.level) || (li ? li.effort : null);
    if (li && li.model && !s.model) s.model = li.model;
    // question en attente : transcript (rare, déjà répondue en pratique) OU live (cas réel)
    s.liveQuestion = liveQuestionForSession(s.id);
    // résumé compact de la TodoList (où en est la session) — léger, pour la sidebar.
    s.todo = todoSummary(latestTodos(s.file));
  }
  // tri : plus récente activité d'abord
  sessions.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  // on n'expose pas byDay en entier dans la liste (lourd) — juste un flag + la question
  // (légère) pour permettre la réponse en 1 clic directement depuis la sidebar.
  return sessions.map(({ byDay, file, pendingQuestion, liveQuestion, ...rest }) => {
    const question = liveQuestion || pendingQuestion || null;
    return { ...rest, hasQuestion: !!question, question };
  });
}

function buildStats(rangeDays) {
  const sessions = scanSessions();
  const cutoff = rangeDays ? Date.now() - rangeDays * 86400000 : 0;
  const totals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, turns: 0, sessions: 0, prompts: 0 };
  const byDay = {};
  const byModel = {};
  const byProject = {};
  const byTool = {};
  for (const s of sessions) {
    const inRange = !cutoff || (s.lastTs && Date.parse(s.lastTs) >= cutoff);
    if (!inRange) continue;
    totals.sessions++;
    totals.prompts += s.userPrompts;
    for (const [day, d] of Object.entries(s.byDay)) {
      if (cutoff && Date.parse(day) < cutoff - 86400000) continue;
      const t = (byDay[day] = byDay[day] || { cost: 0, output: 0, input: 0, cacheRead: 0, turns: 0 });
      t.cost += d.cost; t.output += d.output; t.input += d.input; t.cacheRead += d.cacheRead; t.turns += d.turns;
      totals.input += d.input; totals.output += d.output; totals.cacheCreate += d.cacheCreate;
      totals.cacheRead += d.cacheRead; totals.cost += d.cost; totals.turns += d.turns;
    }
    if (s.model) {
      const m = (byModel[s.model] = byModel[s.model] || { cost: 0, turns: 0 });
      m.cost += s.cost; m.turns += s.assistantTurns;
    }
    const pn = s.projectName || 'inconnu';
    const pr = (byProject[pn] = byProject[pn] || { cost: 0, sessions: 0, output: 0 });
    pr.cost += s.cost; pr.sessions++; pr.output += s.usage.output;
    for (const [tool, n] of Object.entries(s.tools)) byTool[tool] = (byTool[tool] || 0) + n;
  }
  return { totals, byDay, byModel, byProject, byTool };
}

function sessionDetail(id) {
  const sessions = scanSessions();
  let s = sessions.find((x) => x.id === id);
  // session tout juste lancée : pas encore de transcript → on la sert depuis les hooks.
  if (!s) s = eventOnlySessions(new Set(sessions.map((x) => x.id))).find((x) => x.id === id);
  if (!s) return null;
  const ev = readEvents().filter((e) => e.session_id === id).slice(-60);
  const last = ev.length ? liveStateFor(ev[ev.length - 1]) : null;
  const messages = buildConversation(s.file);
  const changes = buildFileChanges(s.file);
  const subagents = buildSubagents(s.file);
  const todos = latestTodos(s.file);
  const pane = paneForSession(id);
  const li = resolveLaunchForSession(id);
  const tmuxName = pane ? paneTmuxNames().get(pane) : null;
  const tmuxAttach = tmuxName ? `tmux attach -t ${tmuxName}` : null;
  // pendingQuestion live (hook) prioritaire ; fallback sur le transcript.
  const pendingQuestion = liveQuestionForSession(id) || s.pendingQuestion || null;
  // statut réel issu de la statusline (effort, rate limits du compte, contexte). Prioritaire.
  const status = sessionStatus(id);
  return {
    ...s, pendingQuestion,
    state: last ? last.state : (s.state || 'past'), currentTool: last ? last.tool : null,
    tmuxPane: pane, tmuxAlive: tmuxAlive(pane), tmuxAttach,
    // mode courant : lu en direct dans le footer du TUI si le pane est vivant (fiable, temps-réel),
    // sinon dernier mode connu via les hooks (différé).
    permissionMode: (tmuxAlive(pane) && readPaneModeSync(pane)) || modeForSession(id),

    effort: (status && status.effort) || (li ? li.effort : null),
    model: (li && li.model && !s.model) ? li.model : s.model,
    launchModel: li ? li.model : null,   // forme courte (opus/sonnet…) pour relancer en conservant la config
    rateLimit: status ? status.rateLimit : null,   // vrais % 5 h / 7 j du compte (via statusline)
    context: status ? status.context : null,        // remplissage de la fenêtre de contexte
    fastMode: status ? status.fastMode : false,
    usage5h: usageWindow(5),                          // proxy coût (fallback si pas de statusline)
    events: ev, messages, changes, subagents,
    todos: todos ? todos.todos : [], todoTs: todos ? todos.ts : null,
  };
}

export { buildSessions, buildStats, sessionDetail, eventOnlySessions };
