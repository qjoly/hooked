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
import { buildSubSessions } from './subSessions.js';
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
// tort en 'idle', et une session finie sans Stop capté finit par retomber en 'idle' (cf. liveStateFor,
// péremption à 5 min). La ligne spinner du footer présente ⇒ Claude bosse (working) ; absente alors
// qu'on le croyait 'idle' ⇒ il attend (waiting). On ne touche jamais 'attention' ni 'ended'.
// `busy` (calculé par l'appelant via paneBusySync) : true = vrai spinner du footer, false = boîte de
// saisie seule, null = pane injoignable (on ne tranche pas).
//
// Pane MORT (tmux fermé) : aucun process ne tourne, la session ne PEUT pas être 'working' — un
// 'working' hérité d'un dernier hook sans Stop/SessionEnd capté est périmé → on le rétrograde en
// 'waiting' (à relancer / en attente de toi). Les autres états (idle/attention/ended/past) restent.
//
// IMPORTANT — on NE rétrograde PAS 'working' → 'waiting' sur busy===false. « Pas de spinner » ≠ « tour
// fini » : c'est AUSSI vrai pendant que Claude STREAME sa réponse finale (après le dernier outil, avant
// le Stop). Le footer n'a alors ni spinner (parseSpinner=null) ni « esc to interrupt » → busy false,
// mais la session travaille encore (texte qui s'écrit). L'ancienne règle la faisait clignoter en
// 'waiting' à tort. Un tour 'working' se termine par un signal AUTORITAIRE : le hook Stop (→ 'waiting',
// cf. liveStateFor) ou un pane mort (ligne 59). Le cas « Stop raté sur pane vivant » n'est pas perdu :
// liveStateFor périme PreToolUse/PostToolUse en 'idle' après 5 min → la démotion 'idle' → 'waiting'
// ci-dessous le rattrape (juste différé, ce cas est rare). Cf. bug « en écriture affiché en attente ».
function refineWithPane(state, alive, busy) {
  if (!alive) return state === 'working' ? 'waiting' : state;
  // busy = vrai spinner d'activité DANS LE FOOTER (parseSpinner est borné aux ~14 lignes au-dessus de
  // l'invite ❯ → un spinner CITÉ dans la conversation ne compte pas, cf. fix dd850e0). On promeut donc
  // 'waiting' → 'working' quand le pane mouline vraiment : après un Stop capté (→ waiting), une
  // ré-invocation par un veilleur / message en file / ScheduleWakeup remet Claude à réfléchir AVANT tout
  // nouveau hook UserPromptSubmit ; sans ça la session resterait figée en 'waiting' (ou 'background')
  // alors qu'elle travaille. pane mort (alive faux, traité ligne 59) → jamais 'working' (fix 1f98901).
  if (busy === true && (state === 'working' || state === 'idle' || state === 'waiting')) return 'working';
  if (busy === false && state === 'idle') return 'waiting';
  return state;
}

// Re-badge une session « tour terminé » en 'background' quand elle a un job/veilleur de fond ENCORE
// actif et que son pane tmux est VIVANT. On ne touche QUE 'waiting' (un Stop capté, autoritaire).
// Pane mort ⇒ le process de fond est mort aussi ⇒ reste 'waiting'.
//
// MAIS 'working' prime sur 'background' : un veilleur/wakeup de fond (Monitor / ScheduleWakeup /
// message en file) peut RÉ-INVOQUER la session après le Stop → elle se remet à mouliner, mais aucun
// hook UserPromptSubmit/PreToolUse n'a encore atterri, donc l'état capté est toujours 'waiting'.
// Si le pane est GÉNUINEMENT actif (busy === true : vrai spinner du footer, borné au footer par
// parseSpinner → un spinner CITÉ dans la conversation ne compte pas), la session travaille pour de
// bon → 'working', pas 'background'. Seule une session waiting+bg au pane inactif reste 'background'.
// `busy` vaut null (pane injoignable) ⇒ on ne promeut pas, on retombe sur 'background' (comportement
// historique) ; un pane MORT (alive faux) n'entre déjà pas dans cette branche.
function withBackgroundState(state, alive, activeCount, busy) {
  if (state === 'waiting' && alive && activeCount > 0) return busy === true ? 'working' : 'background';
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
    // busy réel du pane, calculé UNE fois et partagé par refineWithPane + withBackgroundState (le
    // cache de capture ne fait qu'un `capture-pane` de toute façon, mais on évite le double appel).
    const busy = s.tmuxAlive ? paneBusySync(s.tmuxPane) : null;
    s.state = refineWithPane(s.state, s.tmuxAlive, busy);
    // jobs de fond encore actifs (Bash run_in_background / Monitor / ScheduleWakeup) : forme légère
    // pour la sidebar. Un 'waiting' au pane vivant qui en a → 'background' (« tourne en fond »),
    // distinct de « en attente de toi ». Cf. server/background.js + withBackgroundState.
    const bgActive = activeBackgroundJobs(s.file);
    s.bgJobs = bgActive.map((j) => ({ kind: j.kind, label: j.description || j.command || j.prompt || j.kind, startedAt: j.startTs }));
    // 'working' prime sur 'background' quand la session a un job de fond ET mouline vraiment.
    s.state = withBackgroundState(s.state, s.tmuxAlive, bgActive.length, busy);
    // verbe d'activité live (« Accomplishing »…) quand Claude mouline — le petit mot animé du TUI.
    // Capture déjà en cache (paneBusySync l'a lue au même tick, cf. busy) → pas de coût tmux en plus.
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

// Résout le chemin du fichier .output d'un job de fond À PARTIR de (session, taskId) — côté serveur.
// Le client ne fournit JAMAIS un chemin brut (anti path-traversal) : on relit les jobs détectés de
// la session et on ne renvoie que le outputPath qu'on a nous-mêmes extrait du transcript. null sinon.
function resolveBackgroundOutput(sessionId, taskId) {
  if (!sessionId || !taskId) return null;
  const s = scanSessions().find((x) => x.id === sessionId);
  if (!s || !s.file) return null;
  const job = buildBackgroundJobs(s.file).jobs.find((j) => j.taskId === taskId);
  return job && job.outputPath ? job.outputPath : null;
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
  // sessions sœurs créées / référencées par cette conversation (cartes vivantes du sous-onglet).
  const subSessions = buildSubSessions(s.file, id);
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
  // busy réel du pane, calculé une fois et partagé par refineWithPane + withBackgroundState.
  const busy = alive ? paneBusySync(pane) : null;
  const refined = refineWithPane(last ? last.state : (s.state || 'past'), alive, busy);
  // jobs de fond encore actifs (liste complète pour l'onglet Background) + relabel 'background'.
  const bg = buildBackgroundJobs(s.file);
  const state = withBackgroundState(refined, alive, bg.active.length, busy);
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
    events: ev, messages, subSessions, changes, subagents,
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

export { buildSessions, buildStats, buildUsage, sessionDetail, sessionByPane, eventOnlySessions, refineWithPane, withBackgroundState, buildBackgroundView, resolveBackgroundOutput };
