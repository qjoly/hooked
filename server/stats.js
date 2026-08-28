/*
 * Agrégations de haut niveau : liste des sessions enrichie de l'état live (buildSessions),
 * statistiques d'usage (buildStats) et détail complet d'une session (sessionDetail).
 */
import path from 'node:path';
import { statSafe } from './util.js';
import { scanSessions, blankSummary } from './transcript.js';
import { repoSlug } from './git.js';
import { readEvents, lastEventBySession, modeForSession, liveQuestionForSession, liveQuestionBySession, livePlanForSession, livePlanBySession, eventSessionMeta, rcSessionIdsFromEvents } from './events.js';
import { liveStateFor } from './live.js';
import { resolveLaunchForSession, agentAlive, agentSession, agentMode, agentAutoApprove, agentBusy, agentActivity, agentFollowup, agentLastProse, agentPendingAsk, liveSessionIds } from './agent.js';
import { sessionStatus, sessionStatusRaw, accountRateLimits, freshestStatusId } from './status.js';
import { scopedLimit, accountLimit, currentUtilization, usageFreshness } from './utilization.js';
import { buildConversation } from './conversation.js';
import { buildSubSessions } from './subSessions.js';
import { buildFileChanges } from './changes.js';
import { buildSubagents } from './subagents.js';
import { latestTodos, todoSummary } from './todos.js';
import { buildBackgroundJobs, jobStatus } from './background.js';
import { DIGEST_PROMPT_PREFIX } from './digests.js';

// Sessions « live-only » : présentes dans les évènements de hooks mais pas encore
// dans un transcript (Claude Code n'écrit le .jsonl qu'au premier message de
// l'assistant). On les synthétise pour qu'elles apparaissent dès le lancement.
// Garde-fou : seulement les sessions récentes, non terminées, sans transcript sur disque
// (sinon scanSessions les aurait déjà ; un transcript supprimé reste donc masqué).
const EVENT_SESSION_MAX_AGE_MIN = 30;
// Outils qui rendent la main à l'utilisateur : leur tour n'est écrit dans le transcript qu'une fois
// la réponse donnée (cf. pendingLeadIn dans sessionDetail).
const HANDOFF_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
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

// Affinage de l'état déduit des hooks par l'état RÉEL de la session pilotée (registre de
// server/agent.js). Les hooks ne signalent ni la réflexion ni le streaming (aucun évènement entre
// deux outils) → sans affinage, une session qui mouline longtemps tombe à tort en 'idle' et une
// session finie sans Stop capté resterait 'working' pour toujours.
//
// Avant la migration, ce signal se devinait à l'écran du TUI : ligne de spinner du footer présente ⇒
// occupé, sinon comparaison du corps de conversation entre deux captures pour distinguer « en train
// d'écrire » de « tour fini » — deux heuristiques fragiles, et la source de plusieurs bugs
// d'affichage clignotant. L'Agent SDK publie l'information directement (`session_state_changed`,
// `status`, `result`), donc on la prend telle quelle :
//   'running'          → la session travaille                              → 'working'
//   'requires_action'  → elle attend une action de toi (question/plan/permission) → 'attention'
//   'idle'             → tour terminé                                      → 'waiting'
// `alive` = la session tourne dans CE processus hooked. Morte (ou jamais pilotée par hooked : une
// session ouverte à la main dans un terminal), on ne peut rien affirmer de plus que les hooks : on
// se contente de rétrograder un 'working' périmé en 'waiting'. On ne touche jamais 'ended'.
function refineWithAgent(state, alive, sdkState) {
  if (state === 'ended') return state;
  if (!alive) return state === 'working' ? 'waiting' : state;
  if (sdkState === 'requires_action') return 'attention';
  if (sdkState === 'running') return 'working';
  if (sdkState === 'idle' && state !== 'attention') return 'waiting';
  return state;
}

// Re-badge une session « tour terminé » en 'background' quand elle a un job/veilleur de fond ENCORE
// actif et qu'elle est VIVANTE. On ne touche QUE 'waiting' (un Stop capté, autoritaire).
// Session morte ⇒ le process de fond est mort avec elle ⇒ reste 'waiting'.
//
// MAIS 'working' prime sur 'background' : un veilleur/wakeup de fond (Monitor / ScheduleWakeup /
// message en file) peut RÉ-INVOQUER la session après le Stop → elle se remet à mouliner, mais aucun
// hook UserPromptSubmit/PreToolUse n'a encore atterri, donc l'état capté est toujours 'waiting'.
// `busy` (registre) tranche : true ⇒ elle travaille pour de bon → 'working'. null (session non
// pilotée) ⇒ on ne promeut pas, on retombe sur 'background' (comportement historique).
function withBackgroundState(state, alive, activeCount, busy) {
  if (state === 'waiting' && alive && activeCount > 0) return busy === true ? 'working' : 'background';
  return state;
}

function buildSessions() {
  const sessions = scanSessions();
  const known = new Set(sessions.map((s) => s.id));
  sessions.push(...eventOnlySessions(known));
  const last = lastEventBySession();
  const questions = liveQuestionBySession(); // une passe (vs liveQuestionForSession par session)
  const plans = livePlanBySession();         // idem pour les plans ExitPlanMode
  // Démons remote-control : masqués de la liste — c'est de l'infra, pas des sessions qu'on pilote.
  // Reconnus par le drapeau `rc` que hook.cjs recopie depuis HOOKED_RC (cf. server/remoteControl.js).
  const hiddenRc = rcSessionIdsFromEvents();
  const visible = sessions.filter((s) => {
    if (hiddenRc.has(s.id)) return false;
    // Nos propres runs `claude -p` de génération de digest sont enregistrés comme des sessions ;
    // on les masque de la liste (infra, pas des sessions qu'on pilote) — cf. server/digests.js.
    if (typeof s.firstPrompt === 'string' && s.firstPrompt.startsWith(DIGEST_PROMPT_PREFIX)) return false;
    return true;
  });
  const now = Date.now();
  for (const s of visible) {
    // dépôt GitHub (owner/repo) pour le regroupement sidebar ; null hors dépôt git.
    s.repo = repoSlug(s.project);
    const ev = last.get(s.id);
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
    // La session tourne-t-elle dans ce hooked ? (remplace « son pane tmux existe-t-il encore ? »)
    // Faux pour une session terminée ET pour une session ouverte à la main dans un terminal : elle
    // reste visible et à jour via les hooks, mais n'est pas pilotable depuis le dashboard.
    const agent = agentSession(s.id);
    s.live = !!agent;
    const busy = agent ? !!agent.busy : null;
    s.state = refineWithAgent(s.state, s.live, agent ? agent.sdkState : null);
    // jobs de fond de la session, chacun classé par jobStatus (croise notif terminale, timeout
    // Monitor, vivacité de la session). SEUL 'running' compte comme actif → forme légère sidebar.
    const bgRunning = buildBackgroundJobs(s.file).jobs
      .filter((j) => jobStatus(j, s.live, now) === 'running');
    s.bgJobs = bgRunning.map((j) => ({ kind: j.kind, label: j.description || j.command || j.prompt || j.kind, startedAt: j.startTs, status: 'running' }));
    // 'working' prime sur 'background' quand la session a un job de fond ET mouline vraiment.
    s.state = withBackgroundState(s.state, s.live, bgRunning.length, busy);
    // outil en cours, publié par le flux SDK (remplace le gérondif animé du spinner du TUI).
    s.activity = (s.state === 'working' && agent) ? agent.activity : null;
    // suggestion de prompt suivant (message `prompt_suggestion` du SDK — c'était le ghost text DIM
    // de la boîte de saisie). Exposée dans la liste pour la proposer en quick action au Deck.
    s.followup = (agent && s.state !== 'working') ? agent.followup : null;
    // effort : vrai effort de la statusline (toutes sessions) en priorité, sinon résolution
    // persistée du lancement (survit à la fin de la session). modèle explicite idem.
    const li = resolveLaunchForSession(s.id);
    const raw = sessionStatusRaw(s.id);
    s.effort = (raw && raw.effort && raw.effort.level) || (li ? li.effort : null);
    if (li && li.model && !s.model) s.model = li.model;
    // Attente en cours : le registre est autoritaire quand la session est pilotée (il couvre AUSSI
    // les demandes de permission d'outil, nouvelles au dashboard) ; sinon on retombe sur les
    // évènements de hooks, seule source pour une session ouverte hors hooked.
    const ask = s.live ? agentPendingAsk(s.id) : null;
    s.liveQuestion = (ask && ask.kind !== 'plan')
      ? { id: ask.id, kind: ask.kind, questions: ask.questions }
      : (questions.get(s.id) || null);
    s.livePlan = (ask && ask.kind === 'plan')
      ? { id: ask.id, plan: ask.plan }
      : (plans.get(s.id) || null);
    // résumé compact de la TodoList (où en est la session) — léger, pour la sidebar.
    s.todo = todoSummary(latestTodos(s.file));
  }
// tri : plus récente activité d'abord
  visible.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  // on n'expose pas byDay en entier dans la liste (lourd) — juste un flag + la question
  // (légère) pour permettre la réponse en 1 clic directement depuis la sidebar.
  return visible.map(({ byDay, file, pendingQuestion, liveQuestion, livePlan,
                         firstPrompt, prLinks, issueLinks, tools, lastPrompt, lastReply, ...rest }) => {
    const question = liveQuestion || pendingQuestion || null;
    // Payload léger pour la LISTE (inbox / board / overview). On retire les champs que seul le
    // DÉTAIL consomme — firstPrompt (Trash a son propre endpoint), prLinks/issueLinks (onglets du
    // cockpit, via sessionDetail), tools (byTool est calculé côté stats sur scanSessions), et le
    // plan complet (juste un flag ici) — et on tronque lastPrompt (affiché en snippet 1 ligne +
    // recherche par préfixe). sessionDetail garde tout, texte intégral. Cf. réduction ~300KB→~180KB.
    return {
      ...rest,
      lastPrompt: typeof lastPrompt === 'string' ? lastPrompt.slice(0, 160) : lastPrompt,
      lastReply: typeof lastReply === 'string' ? lastReply.slice(0, 240) : lastReply,
      hasQuestion: !!question, question, hasPlan: !!livePlan,
    };
  });
}

// Enveloppes ASYNCHRONES conservées pour les endpoints chauds (/api/sessions, poll ~5 s) et pour le
// détail. Elles ne réchauffent plus rien : l'état live vient d'un registre EN MÉMOIRE (server/agent.js)
// au lieu de `tmux capture-pane`. Avant, chaque session vivante déclenchait une capture SYNCHRONE
// (~74 ms) dans la boucle, ce qui gelait l'event loop par paquets de 500 ms–1 s à 80 sessions et
// obligeait à un pré-chauffage concurrent. Il ne reste rien à pré-charger — on garde les noms pour ne
// changer aucune signature d'appelant.
async function buildSessionsWarm() { return buildSessions(); }
async function sessionDetailWarm(id) { return sessionDetail(id); }

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
// contexte/effort/modèle de la session la plus fraîche (statusline) + rate limits du compte.
// Réutilise server/status.js ; dégrade en null si aucun snapshot.
// The Fable weekly bucket is model-scoped: absent from the statusline payload, so it comes from
// the account usage endpoint / Claude Code's usage cache (cf. server/utilization.js) and is merged
// into `account`, along with `usage` (which source answered, how old) for the staleness hint.
// The 5h / 7d buckets stay statusline-driven (refreshed on every render) and only fall back to the
// usage payload when NO snapshot carries rate limits — e.g. no session open since the last restart.
function buildUsage() {
  const id = freshestStatusId();
  const session = id ? sessionStatus(id) : null;   // contexte/effort/modèle/fastMode + rateLimit
  const rl = accountRateLimits();                  // le + frais AVEC rate_limits, toutes sessions
  const util = currentUtilization();
  const fable = scopedLimit('Fable', util);
  const fresh = usageFreshness();
  const fallback = rl ? null : {
    fiveHour: accountLimit('session', util),
    sevenDay: accountLimit('weekly_all', util),
    at: fresh.at,
  };
  const merged = rl || (fallback && (fallback.fiveHour || fallback.sevenDay) ? fallback : null);
  const account = (merged || fable)
    ? { fiveHour: null, sevenDay: null, at: null, ...merged, fable, usage: fresh }
    : null;
  return { sessionId: id, session, account };
}

// Vue GLOBALE des jobs de fond encore actifs, toutes sessions confondues (pour /api/background +
// la carte Overview). Cleanly-separable : ne dépend que de scanSessions + background.js. Ne retient
// que les sessions VIVANTES (session terminée = process de fond mort avec elle). Trié du plus
// récent d'abord.
function buildBackgroundView() {
  const rows = [];
  const alive = new Set(liveSessionIds());
  for (const s of scanSessions()) {
    if (!alive.has(s.id)) continue;
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
        // session vivante ici (gate au-dessus) → alive=true ; distingue running d'un Monitor expiré.
        status: jobStatus(j, true, Date.now()),
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
  const changes = buildFileChanges(s.file, id);
  // Tours (prompts) de la conversation, pour filtrer les changements par prompt dans la lentille
  // Ship. On exclut les tours auto (wakeups SDK) ; l'attribution op→tour se fait par timestamp.
  const changeTurns = messages
    .filter((m) => m.role === 'user' && !m.auto && m.ts)
    .map((m, i) => ({ turn: i, ts: m.ts, prompt: (m.text || '').replace(/\s+/g, ' ').trim().slice(0, 100) }));
  const subagents = buildSubagents(s.file);
  const todos = latestTodos(s.file);
  const li = resolveLaunchForSession(id);
  const agent = agentSession(id);
  const alive = !!agent;
  // Attente en cours. Le registre de l'Agent SDK est autoritaire quand la session est pilotée : la
  // promesse `canUseTool` EST l'attente, il n'y a pas de décalage possible. Il couvre en plus les
  // demandes de PERMISSION d'outil, qu'on ne pouvait auparavant traiter que dans le TUI (donc via
  // tmux) : elles arrivent ici sous la même forme qu'une question, options « Allow once / Allow
  // always / Deny ». Sinon (session non pilotée) on retombe sur les hooks puis le transcript.
  const ask = alive ? agentPendingAsk(id) : null;
  const pendingQuestion = (ask && ask.kind !== 'plan')
    ? { id: ask.id, kind: ask.kind, toolName: ask.toolName, questions: ask.questions }
    : (liveQuestionForSession(id) || s.pendingQuestion || null);
  const pendingPlan = (ask && ask.kind === 'plan')
    ? { id: ask.id, plan: ask.plan }
    : livePlanForSession(id);
  // statut réel issu de la statusline (effort, rate limits du compte, contexte). Prioritaire.
  const status = sessionStatus(id);
  // Texte d'introduction de la question / du plan en attente.
  // Tant qu'une AskUserQuestion (ou un ExitPlanMode) n'a pas reçu sa réponse, Claude Code n'écrit
  // RIEN du tour dans le transcript : thinking + texte + tool_use y tombent d'un seul coup à la
  // seconde où l'on répond. La prose qui précède la question — celle dont on a besoin POUR répondre
  // — n'existe donc sur disque qu'APRÈS coup, et aucun refetch ne la fera apparaître avant.
  // On la prend donc dans le dernier bloc de texte assistant vu passer sur le flux SDK (qui, lui,
  // le livre en temps réel) tant que le tour n'est pas retombé dans le .jsonl — là où l'ancien code
  // devait la re-scraper dans l'écran du TUI avec son scrollback.
  // Le témoin du flush : un chip de hand-off SANS RÉSULTAT dans la dernière bulle (l'appel
  // est écrit, sa réponse pas encore). Tester la seule présence du chip ne marche pas — la bulle
  // précédente porte le chip de la question DÉJÀ répondue (avec son résultat), ce qui coupait le
  // lead-in à chaque question posée après une première (mesuré de bout en bout sur l'API).
  const flushedHandoff = (() => {
    const m = messages[messages.length - 1];
    if (!m || m.role !== 'assistant') return false;
    return (m.parts || []).some((p) => p.type === 'tool' && HANDOFF_TOOLS.has(p.tool && p.tool.name) && !p.tool.result);
  })();
  const pendingLeadIn = ((pendingQuestion || pendingPlan) && alive && !flushedHandoff)
    ? agentLastProse(id) : null;
  const busy = agent ? !!agent.busy : null;
  const refined = refineWithAgent(last ? last.state : (s.state || 'past'), alive, agent ? agent.sdkState : null);
  // jobs de fond de la session : TOUS (actifs + historique) avec leur statut, pour l'onglet Background.
  const bg = buildBackgroundJobs(s.file);
  const now = Date.now();
  const bgJobs = bg.jobs
    .map((j) => ({ ...j, status: jobStatus(j, alive, now) }))
    // running d'abord, puis les plus récents (doneAt sinon startTs) en tête ; borné à ~30 (payload).
    .sort((a, b) => {
      const ar = a.status === 'running' ? 1 : 0, br = b.status === 'running' ? 1 : 0;
      if (ar !== br) return br - ar;
      return String(b.doneAt || b.startTs || '').localeCompare(String(a.doneAt || a.startTs || ''));
    })
    .slice(0, 30);
  const runningCount = bgJobs.filter((j) => j.status === 'running').length;
  const state = withBackgroundState(refined, alive, runningCount, busy);
  return {
    ...s, pendingQuestion, pendingPlan, pendingLeadIn, changeTurns,
    state, currentTool: last ? last.tool : null,
    bgJobs,
    // outil en cours, publié par le flux SDK (remplace le gérondif animé du spinner du TUI).
    activity: (state === 'working' && agent) ? agent.activity : null,
    // suggestion de prompt suivant (message `prompt_suggestion` du SDK) quand le tour est fini.
    followupSuggestion: (agent && state !== 'working') ? agent.followup : null,
    // la session est-elle pilotable depuis le dashboard ? (elle tourne dans ce processus hooked)
    live: alive,
    // deep-link relatif vers cette session (à émettre par un agent en markdown : `[label](/session/<id>)`).
    link: '/session/' + encodeURIComponent(id),
    // mode courant : lu dans le registre quand la session est pilotée (le SDK le publie sur
    // `system/init` et `system/status`, fiable et temps-réel), sinon dernier mode vu par les hooks.
    permissionMode: agentMode(id) || modeForSession(id),
    // auto-approbation des demandes de permission d'outil (interrupteur de session, cf.
    // server/agent.js → setAutoApprove).
    autoApprove: agentAutoApprove(id),

    effort: (status && status.effort) || (li ? li.effort : null),
    model: (li && li.model && !s.model) ? li.model : s.model,
    launchModel: li ? li.model : null,   // forme courte (opus/sonnet…) pour relancer en conservant la config
    rateLimit: status ? status.rateLimit : null,   // vrais % 5 h / 7 j du compte (via statusline)
    context: status ? status.context : null,        // remplissage de la fenêtre de contexte
    fastMode: status ? status.fastMode : false,
    events: ev, messages, subSessions, changes, subagents,
    todos: todos ? todos.todos : [], todoTs: todos ? todos.ts : null,
  };
}

export { buildSessions, buildSessionsWarm, buildStats, buildUsage, sessionDetail, sessionDetailWarm, eventOnlySessions, refineWithAgent, withBackgroundState, buildBackgroundView, resolveBackgroundOutput };
