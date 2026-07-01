/*
 * Agrégations de haut niveau : liste des sessions enrichie de l'état live (buildSessions),
 * statistiques d'usage (buildStats) et détail complet d'une session (sessionDetail).
 */
import path from 'node:path';
import { statSafe } from './util.js';
import { scanSessions, blankSummary } from './transcript.js';
import { repoSlug } from './git.js';
import { readEvents, lastEventBySession, paneForSession, sessionForPane, modeForSession, liveQuestionForSession, livePlanForSession, eventSessionMeta } from './events.js';
import { liveStateFor } from './live.js';
import { resolveLaunchForSession, paneTmuxNames, tmuxAlive, readPaneModeSync, paneBusySync, paneActivitySync } from './tmux.js';
import { shownPanesFor } from './pane.js';
import { usageWindow } from './usage.js';
import { sessionStatus, sessionStatusRaw, accountRateLimits, freshestStatusId } from './status.js';
import { buildConversation } from './conversation.js';
import { buildFileChanges } from './changes.js';
import { buildSubagents } from './subagents.js';
import { latestTodos, todoSummary } from './todos.js';
import { buildBackgroundJobs, activeBackgroundJobs } from './background.js';

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
    // transcript déplacé à la corbeille (<projet>/bin/, cf. trash.js) → session supprimée : ne pas
    // la ressusciter en « event-only » (sinon elle réapparaît vide dans le dashboard).
    if (m.transcript && statSafe(path.join(path.dirname(m.transcript), 'bin', path.basename(m.transcript)))) continue;
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

// Affinage de l'état déduit des hooks par une lecture du pane vivant. Les hooks ne signalent pas la
// réflexion/le streaming (aucun event entre deux outils) → une session qui mouline longtemps tombe à
// tort en 'idle', et une session finie sans Stop capté reste 'working'. La ligne spinner du footer
// présente ⇒ Claude bosse (working) ; absente alors qu'on le croyait actif ⇒ il attend (waiting).
// On ne touche jamais 'attention' (plan/question/permission) ni 'ended'.
//
// Pane MORT (tmux fermé) : aucun process ne tourne, la session ne PEUT pas être 'working' — un
// 'working' hérité d'un dernier hook sans Stop/SessionEnd capté est périmé → on le rétrograde en
// 'waiting' (à relancer / en attente de toi). Les autres états (idle/attention/ended/past) restent.
function refineWithPane(state, pane, alive) {
  if (!alive) return state === 'working' ? 'waiting' : state;
  const busy = paneBusySync(pane);
  // busy n'affine QUE 'working'/'idle' : un 'waiting' vient d'un Stop capté (Claude a fini) et fait
  // autorité — on ne le re-promeut jamais en 'working' (sinon un spinner résiduel/cité relancerait à
  // tort une session à l'arrêt). Un vrai nouveau tour repasse par un hook UserPromptSubmit → 'working'.
  if (busy === true && (state === 'working' || state === 'idle')) return 'working';
  if (busy === false && (state === 'working' || state === 'idle')) return 'waiting';
  return state;
}

// Re-badge une session « tour terminé » en 'background' quand elle a un job/veilleur de fond ENCORE
// actif et que son pane tmux est VIVANT. On ne touche QUE 'waiting' (un Stop capté, autoritaire) :
// la règle d'autorité de refineWithPane est préservée — on subdivise « le tour est fini », on ne
// re-promeut jamais vers 'working'. Pane mort ⇒ le process de fond est mort aussi ⇒ reste 'waiting'.
function withBackgroundState(state, alive, activeCount) {
  if (state === 'waiting' && alive && activeCount > 0) return 'background';
  return state;
}

function buildSessions() {
  const sessions = scanSessions();
  const known = new Set(sessions.map((s) => s.id));
  sessions.push(...eventOnlySessions(known));
  const last = lastEventBySession();
  const now = Date.now();
  for (const s of sessions) {
    // dépôt GitHub (owner/repo) pour le regroupement sidebar ; null hors dépôt git.
    s.repo = repoSlug(s.project);
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
    s.state = refineWithPane(s.state, s.tmuxPane, s.tmuxAlive);
    // jobs de fond encore actifs (Bash run_in_background / Monitor / ScheduleWakeup) : forme légère
    // pour la sidebar. Un 'waiting' au pane vivant qui en a → 'background' (« tourne en fond »),
    // distinct de « en attente de toi ». Cf. server/background.js + withBackgroundState.
    const bgActive = activeBackgroundJobs(s.file);
    s.bgJobs = bgActive.map((j) => ({ kind: j.kind, label: j.description || j.command || j.prompt || j.kind, startedAt: j.startTs }));
    s.state = withBackgroundState(s.state, s.tmuxAlive, bgActive.length);
    // verbe d'activité live (« Accomplishing »…) quand Claude mouline — le petit mot animé du TUI.
    // Capture déjà en cache (refineWithPane vient de la lire au même tick) → pas de coût tmux en plus.
    s.activity = (s.state === 'working' && s.tmuxAlive) ? paneActivitySync(s.tmuxPane) : null;
    // effort : vrai effort de la statusline (toutes sessions) en priorité, sinon résolution
    // persistée du lancement hooked (survit à la mort du tmux). modèle explicite idem.
    const li = resolveLaunchForSession(s.id);
    const raw = sessionStatusRaw(s.id);
    s.effort = (raw && raw.effort && raw.effort.level) || (li ? li.effort : null);
    if (li && li.model && !s.model) s.model = li.model;
    // question en attente : transcript (rare, déjà répondue en pratique) OU live (cas réel)
    s.liveQuestion = liveQuestionForSession(s.id);
    // plan ExitPlanMode en attente d'approbation (source live des hooks) — pour le flag sidebar.
    s.livePlan = livePlanForSession(s.id);
    // résumé compact de la TodoList (où en est la session) — léger, pour la sidebar.
    s.todo = todoSummary(latestTodos(s.file));
  }
  // tri : plus récente activité d'abord
  sessions.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  // on n'expose pas byDay en entier dans la liste (lourd) — juste un flag + la question
  // (légère) pour permettre la réponse en 1 clic directement depuis la sidebar.
  return sessions.map(({ byDay, file, pendingQuestion, liveQuestion, livePlan, ...rest }) => {
    const question = liveQuestion || pendingQuestion || null;
    // le plan complet (markdown) reste au détail ; la liste n'expose qu'un flag (payload léger).
    return { ...rest, hasQuestion: !!question, question, hasPlan: !!livePlan };
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
    const pn = s.projectName || 'unknown';
    const pr = (byProject[pn] = byProject[pn] || { cost: 0, sessions: 0, output: 0 });
    pr.cost += s.cost; pr.sessions++; pr.output += s.usage.output;
    for (const [tool, n] of Object.entries(s.tools)) byTool[tool] = (byTool[tool] || 0) + n;
  }
  return { totals, byDay, byModel, byProject, byTool };
}

// Équivalent de `/usage` pour l'onglet Stats : rate limits du compte (5 h / 7 j, globaux),
// contexte/effort/modèle de la session la plus fraîche (statusline), + fenêtre budget 5 h (proxy
// coût). Réutilise server/status.js + server/usage.js ; dégrade en null si aucun snapshot.
function buildUsage() {
  const id = freshestStatusId();
  const session = id ? sessionStatus(id) : null;   // contexte/effort/modèle/fastMode + rateLimit
  const account = accountRateLimits();             // le + frais AVEC rate_limits, toutes sessions
  return { sessionId: id, session, account, budget: usageWindow() };
}

// Vue GLOBALE des jobs de fond encore actifs, toutes sessions confondues (pour /api/background +
// la carte Overview). Cleanly-separable : ne dépend que de scanSessions + background.js. Ne retient
// que les sessions au pane VIVANT (un pane mort = process de fond mort). Trié du plus récent d'abord.
function buildBackgroundView() {
  const rows = [];
  for (const s of scanSessions()) {
    const pane = paneForSession(s.id);
    if (!tmuxAlive(pane)) continue;
    for (const j of buildBackgroundJobs(s.file).active) {
      rows.push({
        sessionId: s.id,
        title: s.title,
        projectName: s.projectName,
        repo: repoSlug(s.project),
        kind: j.kind,
        description: j.description || null,
        command: j.command || j.prompt || null,
        taskId: j.taskId || null,
        startedAt: j.startTs || null,
      });
    }
  }
  rows.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  return { jobs: rows, count: rows.length };
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
  // plan ExitPlanMode en attente d'approbation (markdown complet, pour l'afficher dans la conversation).
  const pendingPlan = livePlanForSession(id);
  // statut réel issu de la statusline (effort, rate limits du compte, contexte). Prioritaire.
  const status = sessionStatus(id);
  const alive = tmuxAlive(pane);
  const refined = refineWithPane(last ? last.state : (s.state || 'past'), pane, alive);
  // jobs de fond encore actifs (liste complète pour l'onglet Background) + relabel 'background'.
  const bg = buildBackgroundJobs(s.file);
  const state = withBackgroundState(refined, alive, bg.active.length);
  return {
    ...s, pendingQuestion, pendingPlan,
    state, currentTool: last ? last.tool : null,
    bgJobs: bg.active,
    // verbe d'activité live du spinner TUI (« Accomplishing »…) quand la session mouline, sinon null.
    activity: (state === 'working' && alive) ? paneActivitySync(pane) : null,
    tmuxPane: pane, tmuxAlive: alive, tmuxAttach,
    // deep-link relatif vers cette session (à émettre par un agent en markdown : `[label](/session/<id>)`).
    link: '/session/' + encodeURIComponent(id),
    // panes « show » ouverts par un agent (mirroir lecture seule dans l'onglet Terminal).
    shownPanes: shownPanesFor(id),
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

// « whoami » : résout le pane tmux ($TMUX_PANE d'une session) vers son détail complet.
// Une session connaît son pane via l'env mais pas son session_id hooked → on fait le pont.
function sessionByPane(pane) {
  const id = sessionForPane(pane);
  if (!id) return null;
  return sessionDetail(id);
}

export { buildSessions, buildStats, buildUsage, sessionDetail, sessionByPane, eventOnlySessions, withBackgroundState, buildBackgroundView };
