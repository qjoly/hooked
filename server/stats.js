/*
 * Agrégations de haut niveau : liste des sessions enrichie de l'état live (buildSessions),
 * statistiques d'usage (buildStats) et détail complet d'une session (sessionDetail).
 */
import path from 'node:path';
import { statSafe } from './util.js';
import { scanSessions, blankSummary } from './transcript.js';
import { repoSlug } from './git.js';
import { readEvents, lastEventBySession, paneForSession, paneBySession, sessionForPane, modeForSession, liveQuestionForSession, liveQuestionBySession, livePlanForSession, livePlanBySession, eventSessionMeta } from './events.js';
import { liveStateFor } from './live.js';
import { resolveLaunchForSession, paneTmuxNames, tmuxAlive, readPaneModeSync, paneBusySync, paneActivitySync, paneFollowupSync, paneActiveSync, warmPaneCaptures, warmPaneNames } from './tmux.js';
import { shownPanesFor } from './pane.js';
import { sessionStatus, sessionStatusRaw, accountRateLimits, freshestStatusId } from './status.js';
import { buildConversation } from './conversation.js';
import { buildSubSessions } from './subSessions.js';
import { buildFileChanges } from './changes.js';
import { buildSubagents } from './subagents.js';
import { latestTodos, todoSummary } from './todos.js';
import { buildBackgroundJobs, jobStatus } from './background.js';
import { isRcTmuxName, markRcSession, rcSessionIdSet } from './remoteControl.js';
import { DIGEST_PROMPT_PREFIX } from './digests.js';

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
// tort en 'idle', et une session finie sans Stop capté resterait 'working' pour toujours. La ligne
// spinner du footer présente ⇒ Claude bosse (working) ; absente ⇒ on regarde si le pane BOUGE encore.
// On ne touche jamais 'attention' ni 'ended'.
// `busy` (calculé par l'appelant via paneBusySync) : true = vrai spinner du footer, false = boîte de
// saisie seule, null = pane injoignable (on ne tranche pas).
// `active` (calculé par l'appelant via paneActiveSync) : true = le corps de conversation a changé
// depuis le tick précédent (Claude écrit), false = corps statique (tour terminé), null = injoignable.
//
// Pane MORT (tmux fermé) : aucun process ne tourne, la session ne PEUT pas être 'working' — un
// 'working' hérité d'un dernier hook sans Stop/SessionEnd capté est périmé → on le rétrograde en
// 'waiting' (à relancer / en attente de toi). Les autres états (idle/attention/ended/past) restent.
//
// SIGNAL « fini » ROBUSTE (busy===false). « Pas de spinner » est vrai DANS DEUX cas indistinguables au
// seul footer : (1) Claude STREAME sa réponse finale (tour EN COURS, texte qui s'écrit) ; (2) le tour
// est TERMINÉ (réponse affichée, composer prêt). On les sépare par le MOUVEMENT du corps de conversation
// (paneActiveSync) : en écriture il grandit (active===true) → on reste 'working' ; terminé il est figé
// (active===false) → on rétrograde 'working'/'idle' → 'waiting'. C'est ce qui remplace l'ancienne
// démotion inconditionnelle sur busy===false (qui faisait clignoter une session EN ÉCRITURE en 'waiting'
// à tort, cf. 52e5e68) tout en rattrapant enfin le Stop raté/absent (bug « working après tour fini »).
// active===null (pane injoignable) ⇒ on ne tranche pas ; active===true seul (1re observation, pas encore
// de recul) ⇒ prudence, on garde l'état. Un Stop capté (→ 'waiting', liveStateFor) reste autoritaire.
function refineWithPane(state, alive, busy, active) {
  if (!alive) return state === 'working' ? 'waiting' : state;
  // busy = vrai spinner d'activité DANS LE FOOTER (parseSpinner est borné aux ~14 lignes au-dessus de
  // l'invite ❯ → un spinner CITÉ dans la conversation ne compte pas, cf. fix dd850e0). On promeut donc
  // 'waiting' → 'working' quand le pane mouline vraiment : après un Stop capté (→ waiting), une
  // ré-invocation par un veilleur / message en file / ScheduleWakeup remet Claude à réfléchir AVANT tout
  // nouveau hook UserPromptSubmit ; sans ça la session resterait figée en 'waiting' (ou 'background')
  // alors qu'elle travaille. pane mort (alive faux, traité au-dessus) → jamais 'working' (fix 1f98901).
  if (busy === true && (state === 'working' || state === 'idle' || state === 'waiting')) return 'working';
  // busy===false : pas de spinner. On ne rétrograde QUE si le corps est AUSSI figé (active===false) —
  // tour réellement terminé. active===true (en écriture) ou null (1re obs / injoignable) → on n'y touche pas.
  if (busy === false && active === false && (state === 'working' || state === 'idle')) return 'waiting';
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
  const panes = paneBySession(); // résolu en une passe (vs paneForSession par session)
  const questions = liveQuestionBySession(); // idem : une passe (vs liveQuestionForSession par session)
  const plans = livePlanBySession();         // idem pour les plans ExitPlanMode
  // Démons remote-control (`hooked-rc-*`) : masqués de la liste — ce sont de l'infra, pas des
  // sessions qu'on pilote depuis hooked. On les reconnaît par le nom tmux de leur pane (live), et on
  // mémorise leur id pour qu'ils restent masqués une fois le pane mort (transcript persistant).
  const paneNames = paneTmuxNames();
  const hiddenRc = rcSessionIdSet();
  const visible = sessions.filter((s) => {
    const ev = last.get(s.id);
    const pane = (ev && ev.tmux_pane) || panes.get(s.id) || null;
    if (isRcTmuxName(pane ? paneNames.get(pane) : null)) { markRcSession(s.id); return false; }
    // Nos propres runs `claude -p` de génération de digest sont enregistrés comme des sessions ;
    // on les masque de la liste (infra, pas des sessions qu'on pilote) — cf. server/digests.js.
    if (typeof s.firstPrompt === 'string' && s.firstPrompt.startsWith(DIGEST_PROMPT_PREFIX)) return false;
    return !hiddenRc.has(s.id);
  });
  const now = Date.now();
  for (const s of visible) {
    // dépôt GitHub (owner/repo) pour le regroupement sidebar ; null hors dépôt git.
    s.repo = repoSlug(s.project);
    const ev = last.get(s.id);
    s.tmuxPane = (ev && ev.tmux_pane) || panes.get(s.id) || null;
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
    // le corps de conversation bouge-t-il encore ? (écriture vs tour terminé) — même capture en cache,
    // pas de `capture-pane` supplémentaire. Appelé à CHAQUE tick pour garder la référence à jour.
    const active = s.tmuxAlive ? paneActiveSync(s.tmuxPane) : null;
    s.state = refineWithPane(s.state, s.tmuxAlive, busy, active);
    // jobs de fond de la session, chacun classé par jobStatus (croise notif terminale, timeout
    // Monitor, vivacité du pane). SEUL 'running' compte comme actif → forme légère pour la sidebar.
    // Un 'waiting' au pane vivant qui en a → 'background' (« tourne en fond »), distinct de « en
    // attente de toi ». Cf. server/background.js + withBackgroundState.
    const bgRunning = buildBackgroundJobs(s.file).jobs
      .filter((j) => jobStatus(j, s.tmuxAlive, now) === 'running');
    s.bgJobs = bgRunning.map((j) => ({ kind: j.kind, label: j.description || j.command || j.prompt || j.kind, startedAt: j.startTs, status: 'running' }));
    // 'working' prime sur 'background' quand la session a un job de fond ET mouline vraiment.
    s.state = withBackgroundState(s.state, s.tmuxAlive, bgRunning.length, busy);
    // verbe d'activité live (« Accomplishing »…) quand Claude mouline — le petit mot animé du TUI.
    // Capture déjà en cache (paneBusySync l'a lue au même tick, cf. busy) → pas de coût tmux en plus.
    s.activity = (s.state === 'working' && s.tmuxAlive) ? paneActivitySync(s.tmuxPane) : null;
    // prompt de follow-up suggéré par le TUI (ghost text) quand le tour est fini — léger, lu depuis
    // le cache de pane déjà réchauffé. Exposé dans la liste pour le proposer en quick action au Deck.
    s.followup = (s.tmuxAlive && s.state !== 'working') ? paneFollowupSync(s.tmuxPane) : null;
    // effort : vrai effort de la statusline (toutes sessions) en priorité, sinon résolution
    // persistée du lancement hooked (survit à la mort du tmux). modèle explicite idem.
    const li = resolveLaunchForSession(s.id, s.tmuxPane);
    const raw = sessionStatusRaw(s.id);
    s.effort = (raw && raw.effort && raw.effort.level) || (li ? li.effort : null);
    if (li && li.model && !s.model) s.model = li.model;
    // question en attente : transcript (rare, déjà répondue en pratique) OU live (cas réel)
    s.liveQuestion = questions.get(s.id) || null;
    // plan ExitPlanMode en attente d'approbation (source live des hooks) — pour le flag sidebar.
    s.livePlan = plans.get(s.id) || null;
    // résumé compact de la TodoList (où en est la session) — léger, pour la sidebar.
    s.todo = todoSummary(latestTodos(s.file));
  }
  // tri : plus récente activité d'abord
  visible.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  // on n'expose pas byDay en entier dans la liste (lourd) — juste un flag + la question
  // (légère) pour permettre la réponse en 1 clic directement depuis la sidebar.
  return visible.map(({ byDay, file, pendingQuestion, liveQuestion, livePlan,
                         firstPrompt, prLinks, issueLinks, tools, lastPrompt, ...rest }) => {
    const question = liveQuestion || pendingQuestion || null;
    // Payload léger pour la LISTE (inbox / board / overview). On retire les champs que seul le
    // DÉTAIL consomme — firstPrompt (Trash a son propre endpoint), prLinks/issueLinks (onglets du
    // cockpit, via sessionDetail), tools (byTool est calculé côté stats sur scanSessions), et le
    // plan complet (juste un flag ici) — et on tronque lastPrompt (affiché en snippet 1 ligne +
    // recherche par préfixe). sessionDetail garde tout, texte intégral. Cf. réduction ~300KB→~180KB.
    return {
      ...rest,
      lastPrompt: typeof lastPrompt === 'string' ? lastPrompt.slice(0, 160) : lastPrompt,
      hasQuestion: !!question, question, hasPlan: !!livePlan,
    };
  });
}

// Enveloppe ASYNCHRONE de buildSessions pour les endpoints chauds (/api/sessions, poll ~5 s) :
// réchauffe en concurrence les captures de pane AVANT la boucle synchrone, pour qu'aucun
// capturePaneTextSync ne spawn un `capture-pane` bloquant sur l'event loop (cf. warmPaneCaptures —
// c'était la cause des gels ~500 ms du terminal). buildSessions reste synchrone (aucune signature
// changée pour ses autres appelants) ; seul le warm est asynchrone. Les appels scanSessions/
// eventOnlySessions sont cachés → le doublon avec buildSessions est quasi gratuit.
async function buildSessionsWarm() {
  const sessions = scanSessions();
  const all = sessions.concat(eventOnlySessions(new Set(sessions.map((s) => s.id))));
  const last = lastEventBySession();
  const paneMap = paneBySession(); // une passe (vs paneForSession par session)
  // warm pane→nom AVANT la boucle : tmuxAlive() en dépend, sinon le 1er appel spawn un
  // `tmux list-panes` synchrone (~250 ms) qui bloque l'event loop (cf. warmPaneNames).
  await warmPaneNames();
  const panes = [];
  for (const s of all) {
    const ev = last.get(s.id);
    const pane = (ev && ev.tmux_pane) || paneMap.get(s.id) || null;
    if (pane && tmuxAlive(pane)) panes.push(pane);
  }
  await warmPaneCaptures(panes);
  return buildSessions();
}

// Idem pour le détail d'une session (l'onglet Terminal vit DANS cette vue, polling répété) : on
// réchauffe le texte ET l'ANSI (paneFollowupSync lit le cache -e) du pane concerné en concurrence
// avant l'appel sync, pour ne pas bloquer sur deux `capture-pane` en série (~150 ms).
async function sessionDetailWarm(id) {
  await warmPaneNames(); // tmuxAlive() ci-dessous + dans sessionDetail en dépendent (évite le spawn sync)
  const pane = paneForSession(id);
  if (pane && tmuxAlive(pane)) await warmPaneCaptures([pane], { ansi: true });
  return sessionDetail(id);
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
// contexte/effort/modèle de la session la plus fraîche (statusline) + rate limits du compte.
// Réutilise server/status.js ; dégrade en null si aucun snapshot.
function buildUsage() {
  const id = freshestStatusId();
  const session = id ? sessionStatus(id) : null;   // contexte/effort/modèle/fastMode + rateLimit
  const account = accountRateLimits();             // le + frais AVEC rate_limits, toutes sessions
  return { sessionId: id, session, account };
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
        // pane vivant ici (gate tmuxAlive au-dessus) → alive=true ; distingue running d'un Monitor expiré.
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
  const changes = buildFileChanges(s.file);
  // Tours (prompts) de la conversation, pour filtrer les changements par prompt dans la lentille
  // Ship. On exclut les tours auto (wakeups SDK) ; l'attribution op→tour se fait par timestamp.
  const changeTurns = messages
    .filter((m) => m.role === 'user' && !m.auto && m.ts)
    .map((m, i) => ({ turn: i, ts: m.ts, prompt: (m.text || '').replace(/\s+/g, ' ').trim().slice(0, 100) }));
  const subagents = buildSubagents(s.file);
  const todos = latestTodos(s.file);
  const pane = paneForSession(id);
  const li = resolveLaunchForSession(id, pane);
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
  // le corps de conversation bouge-t-il encore ? (écriture vs tour terminé) — même capture en cache.
  const active = alive ? paneActiveSync(pane) : null;
  const refined = refineWithPane(last ? last.state : (s.state || 'past'), alive, busy, active);
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
    ...s, pendingQuestion, pendingPlan, changeTurns,
    state, currentTool: last ? last.tool : null,
    bgJobs,
    // verbe d'activité live du spinner TUI (« Accomplishing »…) quand la session mouline, sinon null.
    activity: (state === 'working' && alive) ? paneActivitySync(pane) : null,
    // prompt de follow-up suggéré par le TUI (ghost text de la boîte de saisie) quand le tour est
    // fini : lu dans la pane (non persisté ailleurs). null si la session mouline / pas de suggestion.
    followupSuggestion: (alive && state !== 'working') ? paneFollowupSync(pane) : null,
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

export { buildSessions, buildSessionsWarm, buildStats, buildUsage, sessionDetail, sessionDetailWarm, sessionByPane, eventOnlySessions, refineWithPane, withBackgroundState, buildBackgroundView, resolveBackgroundOutput };
