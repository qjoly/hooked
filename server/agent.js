/*
 * Pilotage des sessions Claude Code via l'Agent SDK d'Anthropic
 * (@anthropic-ai/claude-agent-sdk). Remplace l'ancien pilotage tmux
 * (send-keys / capture-pane) : au lieu de « taper » dans un TUI et de scraper
 * son écran, on tient les sessions EN PROCESSUS avec `query()` en mode
 * streaming input/output, et on lit un flux de messages STRUCTURÉS.
 *
 * Ce que ça change, concrètement :
 *   • plus de parsing d'écran (spinner, footer de mode, ghost text…) : l'état
 *     vient de `system/session_state_changed`, `system/status`, des messages
 *     assistant et de `prompt_suggestion` ;
 *   • plus de navigation clavier pour AskUserQuestion / ExitPlanMode : le
 *     callback `canUseTool` bloque l'appel d'outil et on le résout avec la
 *     réponse de l'UI web ;
 *   • les demandes de permission d'outil deviennent répondables depuis le web
 *     (avant il fallait l'onglet Terminal, donc tmux).
 *
 * Ce que ça coûte : une session vit dans le processus hooked. Un redémarrage
 * de hooked les termine (le transcript reste sur disque → `restartSession`
 * reprend là où on en était). Le registre est épinglé sur `globalThis` pour
 * survivre aux ré-exécutions de module de Vite en dev.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { LAUNCHES_FILE, SESSION_LAUNCH_FILE, DRIVEN_FILE, PERMISSION_MODES, LAUNCH_PERMISSION_MODES, isValidModelArg } from './config.js';
import { isValidEffort } from './capabilities.js';
import { statSafe } from './util.js';
import { scanSessions } from './transcript.js';
import { readSettings } from './settings.js';

function err400(msg) { const e = new Error(msg); e.code = 400; return e; }

// Registre des sessions vivantes, épinglé sur globalThis : `npm run live` ré-exécute les modules
// server/* à la requête suivante après une modif back, ce qui recréerait un registre vide et
// perdrait les sessions en cours (elles tournent dans CE processus, pas dans un tmux détaché).
const REGISTRY = Symbol.for('hooked.agent.registry');
/** @type {Map<string, any>} */
const live = globalThis[REGISTRY] || (globalThis[REGISTRY] = new Map());

// Sessions dont le `system/init` n'est pas encore arrivé : on ne connaît pas leur session_id, mais
// on veut déjà pouvoir les annuler. Indexées par une clé de lancement temporaire.
const PENDING = Symbol.for('hooked.agent.pending');
/** @type {Map<string, any>} */
const pending = globalThis[PENDING] || (globalThis[PENDING] = new Map());

const INIT_TIMEOUT = 30000; // attente max du `system/init` (id de session) au lancement

// ── Abonnés au flux d'une session (streaming temps réel vers l'UI) ───────────────────────────────
// Le SSE global (`/api/stream`) ne pousse qu'un « tick » : le client refetch alors tout le détail de
// session. C'est parfait au rythme du transcript (une écriture par message), mais inutilisable au
// rythme des tokens — on ne va pas re-livrer 1000 messages à chaque delta. D'où ce canal PAR
// SESSION : `/api/session/stream?id=` s'abonne ici et ne reçoit que les deltas.
const SUBS = Symbol.for('hooked.agent.subs');
/** @type {Map<string, Set<Function>>} */
const subs = globalThis[SUBS] || (globalThis[SUBS] = new Map());

// Coalescence : les deltas de texte arrivent par petits paquets très rapprochés. Les pousser un par
// un noierait le client en frames SSE pour un gain visuel nul (l'œil ne suit pas plus vite que
// ~15 im/s). On regroupe donc par fenêtre courte, en gardant la dernière valeur connue.
const FLUSH_MS = 60;
const flushTimers = new Map();

function subscribeAgent(id, cb) {
  if (!id || typeof cb !== 'function') return () => {};
  let set = subs.get(id);
  if (!set) { set = new Set(); subs.set(id, set); }
  set.add(cb);
  return () => {
    const cur = subs.get(id);
    if (!cur) return;
    cur.delete(cb);
    if (!cur.size) subs.delete(id);
  };
}

// Pousse immédiatement (`now`) ou à la prochaine fenêtre de coalescence.
function emitAgent(id, event, now = false) {
  const set = subs.get(id);
  if (!set || !set.size) return;
  const send = () => {
    flushTimers.delete(id);
    for (const cb of [...set]) { try { cb(event()); } catch (_) { set.delete(cb); } }
  };
  if (now) { clearTimeout(flushTimers.get(id)); return send(); }
  if (flushTimers.has(id)) return;                 // une fenêtre est déjà armée
  flushTimers.set(id, setTimeout(send, FLUSH_MS));
}

// Instantané sérialisable de ce qu'un client a besoin de savoir en direct. Volontairement PETIT :
// c'est envoyé plusieurs fois par seconde pendant qu'un tour se déroule.
function streamSnapshot(st) {
  return {
    state: st.sdkState || 'idle',
    busy: !!st.busy,
    activity: st.activity || null,
    text: (st.stream && st.stream.text) || '',
    thinking: (st.stream && st.stream.thinking) || '',
    tool: (st.stream && st.stream.tool) || null,
    ended: !!st.ended,
  };
}

// ── Environnement du shell de login ──────────────────────────────────────────────────────────────
// L'ancien pilotage tmux lançait `claude` via `$SHELL -l -i -c …` : le profil de l'utilisateur
// (~/.zprofile, ~/.zshrc…) était donc sourcé, et chaque session héritait du PATH et des variables
// qu'il y déclare. L'Agent SDK, lui, spawne le CLI avec l'environnement de hooked — sous launchd
// c'est un PATH figé au moment de l'installation du service. Mesuré sur une vraie machine : 26
// entrées de PATH perdues (`~/.krew/bin`, `~/.nix-profile/bin`, `~/go/bin`, `~/.local/bin`, `/sbin`,
// `/usr/sbin`, `/opt/podman/bin`…) et des variables réelles avec (`GITHUB_TOKEN`,
// `NIX_SSL_CERT_FILE`, `K9S_CONFIG_DIR`…). Concrètement : un `kubectl` qui ne trouve plus son plugin
// d'auth OIDC, un `gh` sans token. On reproduit donc explicitement ce que `-l -i` faisait.
//
// Résolu UNE fois par processus (~1,8 s de shell de login sur une config chargée), en asynchrone et
// mis en cache sur globalThis. Lancé dès l'import pour que le premier lancement n'attende rien.
const LOGIN_ENV = Symbol.for('hooked.agent.loginEnv');
const LOGIN_ENV_TIMEOUT = 8000;
// Marqueur émis AVANT `env -0` : un profil bavard (mise activate, message du jour…) écrit sur stdout,
// on ne garde donc que ce qui suit la sentinelle.
const ENV_SENTINEL = '__HOOKED_ENV__';
// Variables qui décrivent le shell RÉSOLVEUR, pas la session : les injecter serait faux (un `PWD`
// qui ne correspond pas au cwd de la session) ou périmé (état de session mise/tmux du résolveur).
const ENV_SKIP = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'TMUX', 'TMUX_PANE', 'MISE_SHELL']);
const isSkippedEnvKey = (k) => ENV_SKIP.has(k) || k.startsWith('__MISE_');

// Parse la sortie de `printf "<sentinelle>\0"; env -0` → objet. Pur/testable.
// `env -0` (NUL comme séparateur) plutôt que des lignes : une variable multi-lignes ne casse rien.
function parseEnvBlock(out) {
  const parts = String(out).split('\0');
  const at = parts.indexOf(ENV_SENTINEL);
  const env = {};
  for (const entry of parts.slice(at + 1)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const k = entry.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || isSkippedEnvKey(k)) continue;
    env[k] = entry.slice(eq + 1);
  }
  return env;
}

// Environnement effectif d'une session : celui de hooked, PUIS le profil par-dessus — même ordre
// qu'avant (tmux passait l'env de hooked au pane, le shell de login le complétait). Ne rejette
// jamais : si le shell de login échoue ou traîne, on retombe sur l'env de hooked (comportement
// dégradé mais fonctionnel) en le signalant une fois dans les logs.
function loginEnv() {
  if (globalThis[LOGIN_ENV]) return globalThis[LOGIN_ENV];
  const shell = process.env.SHELL || '/bin/zsh';
  globalThis[LOGIN_ENV] = new Promise((resolve) => {
    execFile(shell, ['-l', '-i', '-c', `printf '${ENV_SENTINEL}\\0'; env -0`],
      { encoding: 'utf8', timeout: LOGIN_ENV_TIMEOUT, maxBuffer: 4 << 20 },
      (err, out) => {
        const env = err ? {} : parseEnvBlock(out);
        if (!env.PATH) {
          console.log(`[hooked] could not read the login shell environment (${shell}): sessions will `
            + 'inherit the hooked process PATH only' + (err ? ` — ${err.message || err}` : ''));
          return resolve({ ...process.env });
        }
        resolve({ ...process.env, ...env });
      });
  });
  return globalThis[LOGIN_ENV];
}
loginEnv(); // pré-chauffage : la résolution démarre à l'import, pas au premier lancement

// ── File d'entrée poussable ───────────────────────────────────────────────────────────────────────
// L'Agent SDK consomme un AsyncIterable de SDKUserMessage. On en fabrique un qu'on peut alimenter
// depuis l'extérieur (chaque réponse de l'UI web = un push), et qu'on ferme pour terminer la session.
function makeInputQueue() {
  const buffer = [];
  let waiter = null;
  let closed = false;
  return {
    push(msg) {
      if (closed) return false;
      if (waiter) { const w = waiter; waiter = null; w({ value: msg, done: false }); }
      else buffer.push(msg);
      return true;
    },
    close() {
      closed = true;
      if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }); }
    },
    get closed() { return closed; },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buffer.length) return Promise.resolve({ value: buffer.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { waiter = resolve; });
        },
      };
    },
  };
}

// Message utilisateur au format attendu par le SDK.
function userMessage(text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: String(text) }] },
    parent_tool_use_id: null,
  };
}

// « La session travaille » / « elle a fini ». Deux helpers plutôt qu'une affectation directe parce
// qu'une ATTENTE en cours (question, plan, permission) prime sur tout : tant que la promesse
// `canUseTool` n'est pas résolue, Claude est bloqué sur toi, et un message d'activité tardif ne doit
// pas repeindre la session en « working » alors que la carte est affichée.
function markRunning(st) { if (st.pendingAsk) return; st.sdkState = 'running'; st.busy = true; }
function markIdle(st) { if (st.pendingAsk) return; st.sdkState = 'idle'; st.busy = false; }

// ── Dérivation de l'état depuis le flux de messages (pur, testable) ──────────────────────────────
// `st` = l'entrée de registre (mutée en place). Renvoie true si l'état visible a changé.
// Les cas traités correspondent 1:1 à ce que l'ancien code lisait à l'écran :
//   status/requesting + session_state_changed → « ça mouline » (ex-spinner)
//   assistant tool_use                        → verbe d'activité (ex-gérondif du spinner)
//   assistant text                            → dernière prose (ex-lastPaneProse)
//   prompt_suggestion                         → follow-up suggéré (ex-ghost text DIM)
function applyMessage(st, msg) {
  if (!msg || typeof msg !== 'object') return false;
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        st.model = msg.model || st.model;
        st.permissionMode = msg.permissionMode || st.permissionMode;
        if (msg.effort) st.effort = msg.effort;
        st.cwd = msg.cwd || st.cwd;
        st.capabilities = msg.capabilities || null;
        return true;
      }
      if (msg.subtype === 'status') {
        // 'requesting' = requête modèle en vol, 'compacting' = compaction : les deux « moulinent ».
        if (msg.status === 'requesting' || msg.status === 'compacting') markRunning(st);
        else markIdle(st);
        if (msg.permissionMode) st.permissionMode = msg.permissionMode;
        return true;
      }
      if (msg.subtype === 'session_state_changed') {
        // Autoritaire QUAND il arrive — mais tous les CLI ne l'émettent pas (mesuré : un tour
        // complet peut n'en produire aucun), d'où les autres signaux d'activité ci-dessous.
        if (msg.state === 'running') markRunning(st);
        else if (msg.state === 'idle') markIdle(st);
        else if (msg.state === 'requires_action') { st.sdkState = 'requires_action'; st.busy = false; }
        return true;
      }
      return false;
    case 'assistant': {
      // Un message assistant arrive = le tour est EN COURS (il n'est clos que par `result`).
      markRunning(st);
      const blocks = (msg.message && msg.message.content) || [];
      let changed = true;
      for (const b of blocks) {
        if (b.type === 'tool_use') { st.activity = b.name || st.activity; changed = true; }
        else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          st.lastProse = b.text.trim().slice(0, 8000);
          changed = true;
        }
      }
      return changed;
    }
    case 'result':
      // Fin de tour : autoritaire, y compris sur une attente restée en l'air.
      st.busy = false;
      st.activity = null;
      st.sdkState = 'idle';
      st.stream = null;   // le transcript porte désormais le tour : le tampon d'affichage n'a plus lieu d'être
      st.lastResult = { costUsd: msg.total_cost_usd || 0, turns: msg.num_turns || 0, isError: !!msg.is_error };
      // Une nouvelle réponse rend la suggestion précédente périmée : elle sera republiée si besoin.
      return true;
    case 'stream_event': {
      // Aperçu live d'un message assistant en cours d'écriture (option `includePartialMessages`).
      // Format : les évènements bruts de l'API (`message_start`, `content_block_start`,
      // `content_block_delta`, …). Le message BUFFERISÉ qui suit reste la source autoritaire (c'est
      // lui qui alimente lastProse et le transcript) ; ceci n'est qu'un tampon d'affichage.
      const ev = msg.event;
      if (!ev) return false;
      // Des deltas qui arrivent sont en soi la preuve que la session travaille. C'est le signal le
      // plus fiable dont on dispose : `session_state_changed` n'est pas émis par tous les CLI, et
      // `status` ne tombe qu'une fois par requête modèle.
      markRunning(st);
      // Un tour comporte plusieurs messages assistant (un par salve d'outils). On repart à zéro à
      // chaque nouveau message : les précédents sont déjà tombés dans le transcript, les réafficher
      // les dupliquerait.
      if (ev.type === 'message_start') { st.stream = { text: '', thinking: '', tool: null, types: {} }; return true; }
      if (!st.stream) st.stream = { text: '', thinking: '', tool: null, types: {} };
      if (ev.type === 'content_block_start') {
        const t = ev.content_block && ev.content_block.type;
        st.stream.types[ev.index] = t;
        // Un bloc tool_use qui commence : on connaît le nom de l'outil avant même son input complet.
        if (t === 'tool_use' && ev.content_block.name) { st.stream.tool = ev.content_block.name; return true; }
        return false;
      }
      if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        if (d.type === 'text_delta' && typeof d.text === 'string') st.stream.text += d.text;
        // Le raisonnement : affiché en retrait dans l'UI. Selon le modèle et `thinking.display`, le
        // texte peut être vide (le bloc arrive quand même) — c'est alors juste un signal « ça pense ».
        else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') st.stream.thinking += d.thinking;
        // Un type de delta inconnu (signature, citations…) n'ajoute rien à afficher, mais markRunning
        // a tourné : c'est quand même une nouvelle pour l'UI, d'où `true` dans tous les cas.
        return true;
      }
      return true;
    }
    case 'prompt_suggestion':
      st.followup = typeof msg.suggestion === 'string' && msg.suggestion.trim() ? msg.suggestion.trim() : null;
      return true;
    case 'tool_use_summary':
      // Résumé d'une salve d'outils (« Searched for 6 patterns… ») : ce n'est pas de la prose de
      // Claude, on ne l'enregistre donc PAS comme lastProse (l'ancien code l'excluait aussi).
      return false;
    default:
      return false;
  }
}

// ── Attentes en cours (question / plan / permission) ─────────────────────────────────────────────
// Un seul « hand-off » à la fois par session : Claude bloque sur l'appel d'outil, donc il n'y a
// jamais deux attentes concurrentes sur l'agent principal.
function setPendingAsk(st, ask) {
  st.pendingAsk = ask;
  st.sdkState = 'requires_action';
  st.busy = false;
}
function clearPendingAsk(st) {
  st.pendingAsk = null;
  st.sdkState = 'running';
  st.busy = true;
}

// Règle « ne me redemande plus pour ce genre d'appel ». Le bridge du CLI fournit d'ordinaire des
// `suggestions` toutes prêtes (elles portent le bon `ruleContent`, ex. `Bash(kubectl:*)`) et il faut
// les préférer. Mais elles peuvent être absentes — et dans ce cas, renvoyer une liste vide ne
// persiste RIEN : l'utilisateur clique « Allow always » et se fait redemander à l'appel suivant.
// D'où ce repli, une règle de session sur le nom de l'outil.
function alwaysAllowRules(toolName, suggestions) {
  if (Array.isArray(suggestions) && suggestions.length) return suggestions;
  return [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }];
}

// Demande de permission d'outil présentée comme une AskUserQuestion à 3 options : l'UI web réutilise
// telle quelle son composant Question (aucune UI nouvelle à écrire), et on retrouve enfin la
// possibilité d'approuver un outil depuis le web — ce qui passait avant par l'onglet Terminal (tmux).
function permissionQuestion(toolName, opts) {
  const title = (opts && opts.title) || `Claude wants to use ${toolName}`;
  return [{
    question: title + ' — allow?',
    header: 'Permission',
    multiSelect: false,
    options: [
      { label: 'Allow once', description: (opts && opts.description) || 'Run this call only.' },
      { label: 'Allow always', description: 'Run it and stop asking for this kind of call in this session.' },
      { label: 'Deny', description: 'Refuse the call and let Claude choose another route.' },
    ],
  }];
}

// ── Lancement / cycle de vie ─────────────────────────────────────────────────────────────────────

// Options SDK communes. `settingSources` est laissé par défaut (tous) : c'est ce qui fait que les
// hooks globaux de ~/.claude/settings.json — donc hook.cjs, donc events.jsonl — continuent de
// s'exécuter pour les sessions lancées par hooked, exactement comme pour le CLI interactif. Sans ça
// on perdrait d'un coup les questions/plans en attente, les todos, les jobs de fond, la statusline…
function sdkOptions({ cwd, model, effort, permissionMode, resumeId, worktree, input, st, env }) {
  const opts = {
    cwd,
    env,
    // Aperçu live des messages assistant (évènements `stream_event`) → c'est ce qui permet de voir
    // la réponse s'écrire au fil de l'eau au lieu d'attendre le flush du message. Coût : beaucoup
    // plus de trafic sur le transport stdio, négligeable en local.
    includePartialMessages: true,
    persistSession: true,
    forkSession: false,
    permissionMode: permissionMode && permissionMode !== 'default' ? permissionMode : undefined,
    model: model || undefined,
    effort: effort || undefined,
    resume: resumeId || undefined,
    abortController: st.abort,
    // Le SDK résout lui-même le binaire Claude Code empaqueté ; override utile si hooked tourne
    // avec un claude installé ailleurs (ex. build local).
    pathToClaudeCodeExecutable: process.env.HOOKED_CLAUDE_BIN || undefined,
    // Suggestions de prompt suivant : c'était le ghost text DIM lu dans la pane, il arrive
    // maintenant en message `prompt_suggestion`.
    promptSuggestions: true,
    canUseTool: (toolName, toolInput, ctx) => handleToolPermission(st, toolName, toolInput, ctx),
    stderr: (data) => { st.stderr = String(data).slice(-4000); },
  };
  if (worktree) opts.extraArgs = { worktree: null }; // `--worktree` : git worktree dédié
  return opts;
}

// `canUseTool` : Claude est BLOQUÉ tant que la promesse n'est pas résolue. Trois cas.
//
// À noter : le CLI ne consulte ce callback que lorsqu'il AURAIT demandé de toute façon. Un appel
// couvert par les règles de l'utilisateur, ou jugé sans risque par le classifieur du mode `auto`,
// n'arrive jamais ici. Ce qui atterrit ici est donc, par construction, ce que Claude Code juge digne
// d'une question — et sans `autoApprove` la session reste plantée sur une carte à valider à la main.
function handleToolPermission(st, toolName, toolInput, ctx) {
  // Les deux outils de HAND-OFF ne sont jamais auto-approuvés : ce sont eux qui portent la question
  // ou le plan qu'on veut voir arriver dans l'UI. C'est toute la différence avec
  // `permissionMode: 'bypassPermissions'`, qui décide en amont du callback.
  const HANDOFF = toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode';
  if (st.autoApprove && !HANDOFF) return Promise.resolve({ behavior: 'allow' });
  return new Promise((resolve) => {
    const finish = (result) => { clearPendingAsk(st); resolve(result); };
    if (ctx && ctx.signal) ctx.signal.addEventListener('abort', () => finish(null), { once: true });

    if (toolName === 'AskUserQuestion') {
      setPendingAsk(st, {
        kind: 'question',
        id: 'ask:' + (ctx && ctx.toolUseID ? ctx.toolUseID : Date.now()),
        toolUseID: ctx && ctx.toolUseID,
        input: toolInput,
        questions: Array.isArray(toolInput && toolInput.questions) ? toolInput.questions : [],
        resolve: finish,
      });
      return;
    }
    if (toolName === 'ExitPlanMode') {
      setPendingAsk(st, {
        kind: 'plan',
        id: 'plan:' + (ctx && ctx.toolUseID ? ctx.toolUseID : Date.now()),
        toolUseID: ctx && ctx.toolUseID,
        plan: typeof (toolInput && toolInput.plan) === 'string' ? toolInput.plan : '',
        resolve: finish,
      });
      return;
    }
    setPendingAsk(st, {
      kind: 'permission',
      id: 'perm:' + (ctx && ctx.toolUseID ? ctx.toolUseID : Date.now()),
      toolUseID: ctx && ctx.toolUseID,
      toolName,
      input: toolInput,
      suggestions: (ctx && ctx.suggestions) || [],
      // `decisionReason` dit POURQUOI le CLI a escaladé cet appel (règle `ask` de l'utilisateur vs
      // jugement du classifieur du mode auto), `matchedAskRule` est posé quand c'est une règle
      // explicite. On les remonte pour que la carte puisse l'afficher au lieu d'un « allow? » nu.
      reason: (ctx && (ctx.decisionReason || ctx.description)) || null,
      askRule: (ctx && ctx.matchedAskRule) || null,
      questions: permissionQuestion(toolName, ctx),
      resolve: finish,
    });
  });
}

// Boucle de lecture du flux : c'est elle qui tient l'état à jour. Ne rejette jamais — une erreur
// est enregistrée sur l'entrée de registre et la session passe en 'ended'.
// Démolit une entrée qui n'a jamais réussi à démarrer. Même nettoyage que le `finally` de readLoop,
// mais applicable quand readLoop n'a rien à finir : sans ça l'entrée reste dans `live` avec
// ended:false et devient un trou noir — deliverReply y pousse des messages et répond OK.
function failStartup(st) {
  clearTimeout(st.watchdog);
  try { st.input.close(); } catch (_) {}
  try { st.abort.abort(); } catch (_) {}
  st.ended = true;
  st.busy = false;
  st.activity = null;
  st.sdkState = 'idle';
  if (st.pendingAsk) { const r = st.pendingAsk.resolve; st.pendingAsk = null; try { r(null); } catch (_) {} }
  if (st.id) {
    emitAgent(st.id, () => streamSnapshot(st), true);
    live.delete(st.id);
  }
  pending.delete(st.launchKey);
  if (st.onInit) { const f = st.onInit; st.onInit = null; f(st); }
}

async function readLoop(st) {
  try {
    for await (const msg of st.q) {
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id && !st.id) {
        st.id = msg.session_id;
        live.set(st.id, st);
        pending.delete(st.launchKey);
        if (st.onInit) { const f = st.onInit; st.onInit = null; f(st); }
      }
      if (!st.sawMsg) { st.sawMsg = true; clearTimeout(st.watchdog); }
      const changed = applyMessage(st, msg);
      st.lastMsgAt = Date.now();
      // On ne pousse aux abonnés que quand l'état visible a bougé. Les deltas de texte passent par
      // la fenêtre de coalescence (FLUSH_MS) ; les transitions qui comptent pour l'UI — fin de tour,
      // attente d'une action — partent tout de suite, sinon la carte question s'afficherait avec
      // jusqu'à 60 ms de retard sur le reste.
      if (changed) {
        const immediate = msg.type === 'result'
          || (msg.type === 'system' && msg.subtype === 'session_state_changed');
        emitAgent(st.id, () => streamSnapshot(st), immediate);
      }
    }
  } catch (e) {
    st.error = e && e.name === 'AbortError' ? null : String((e && e.message) || e);
  } finally {
    clearTimeout(st.watchdog);
    st.ended = true;
    st.busy = false;
    st.activity = null;
    st.sdkState = 'idle';
    // Une attente non résolue (question/plan/permission) doit être libérée, sinon la promesse
    // `canUseTool` fuite et le sous-processus resterait bloqué à la sortie.
    if (st.pendingAsk) { const r = st.pendingAsk.resolve; st.pendingAsk = null; try { r(null); } catch (_) {} }
    if (st.onInit) { const f = st.onInit; st.onInit = null; f(st); }
    if (st.id) {
      emitAgent(st.id, () => streamSnapshot(st), true);
      live.delete(st.id);
    }
    pending.delete(st.launchKey);
  }
}

// Persiste modèle/effort choisis au lancement : l'UI doit pouvoir les afficher même après la fin
// de la session (le registre, lui, ne survit pas au processus).
function persistLaunch(sessionId, model, effort) {
  if (!sessionId) return;
  try {
    fs.appendFileSync(SESSION_LAUNCH_FILE, JSON.stringify({
      ts: new Date().toISOString(), session_id: sessionId, model: model || null, effort: effort || null,
    }) + '\n');
  } catch (_) {}
}

// map persistée session_id → { model, effort }, rechargée par mtime/size (inchangée depuis tmux.js).
let sessionLaunchCache = { key: null, map: new Map() };
function sessionLaunchMap() {
  const stf = statSafe(SESSION_LAUNCH_FILE);
  if (!stf) return sessionLaunchCache.map;
  const key = stf.mtimeMs + ':' + stf.size;
  if (sessionLaunchCache.key === key) return sessionLaunchCache.map;
  const map = new Map();
  let data = '';
  try { data = fs.readFileSync(SESSION_LAUNCH_FILE, 'utf8'); } catch (_) { return sessionLaunchCache.map; }
  for (const line of data.split('\n')) {
    if (!line) continue;
    try { const j = JSON.parse(line); if (j.session_id) map.set(j.session_id, { model: j.model || null, effort: j.effort || null }); } catch (_) {}
  }
  sessionLaunchCache = { key, map };
  return map;
}

// modèle/effort d'une session : registre vivant en priorité (source de vérité immédiate), sinon la
// résolution persistée du lancement.
function resolveLaunchForSession(id) {
  if (!id) return null;
  const st = live.get(id);
  if (st && (st.launchModel || st.launchEffort)) return { model: st.launchModel || null, effort: st.launchEffort || null };
  return sessionLaunchMap().get(id) || null;
}

// Lance `claude` via l'Agent SDK. `resumeId` reprend une session existante ; `worktree` ne vaut que
// pour une session neuve (une reprise rouvre la session dans son dossier d'origine).
function launchSession({ resumeId, cwd, prompt, model, effort, worktree, permissionMode, autoApprove }, cb) {
  let dir = cwd && typeof cwd === 'string' ? cwd : null;
  let id = null;
  if (resumeId) {
    if (!/^[A-Za-z0-9._-]+$/.test(resumeId)) return cb(err400('invalid session id'));
    const sess = scanSessions().find((s) => s.id === resumeId);
    if (!sess) return cb(err400('session not found'));
    dir = dir || sess.project;
    id = resumeId;
  }
  // Aucun cwd (ni resume) : projet par défaut des réglages (quickLaunchProject) — permet à un
  // déclencheur externe (Quick Action macOS) de POST /api/launch avec seulement un prompt.
  if (!dir) {
    const def = readSettings().quickLaunchProject;
    if (def) dir = def;
  }
  if (!dir) return cb(err400('directory (cwd) required'));
  const stDir = statSafe(dir);
  if (!stDir || !stDir.isDirectory()) return cb(err400('invalid cwd: ' + dir));

  if (model && !isValidModelArg(model)) return cb(err400('unknown model: ' + model));
  if (effort && !isValidEffort(effort)) return cb(err400('unknown effort: ' + effort));
  if (permissionMode && !LAUNCH_PERMISSION_MODES.includes(permissionMode)) return cb(err400('unknown permission mode: ' + permissionMode));
  if (id && live.has(id)) return cb(err400('session already running'));
  const useWorktree = !!worktree && !id;

  const input = makeInputQueue();
  const st = {
    id: id || null,
    launchKey: 'launch:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    cwd: dir,
    input,
    abort: new AbortController(),
    launchModel: model || null,
    launchEffort: effort || null,
    model: model || null,
    effort: effort || null,
    permissionMode: permissionMode || 'default',
    worktree: useWorktree,
    busy: false,
    sdkState: 'idle',
    activity: null,
    lastProse: null,
    followup: null,
    pendingAsk: null,
    // Auto-approbation des demandes de permission d'outil (cf. setAutoApprove). ACTIVÉE PAR DÉFAUT :
    // hooked est un dashboard qu'on regarde de loin, souvent depuis le téléphone — une session
    // plantée sur une carte « allow? » à chaque commande escaladée n'avance pas. Le mode de
    // permission reste, lui, celui demandé au lancement : c'est LUI qui décide ce qui escalade
    // (règles de l'utilisateur, classifieur du mode `auto`), pendant que ce drapeau décide si on te
    // pose la question quand ça escalade. Coupable par session depuis l'en-tête, et les questions
    // comme les plans continuent d'arriver dans tous les cas.
    autoApprove: autoApprove !== false,
    ended: false,
    error: null,
    sawMsg: false,   // le CLI a-t-il produit au moins un message ? (cf. chien de garde)
    watchdog: null,
    startedAt: new Date().toISOString(),
    lastMsgAt: Date.now(),
  };
  // Enregistrés SYNCHRONEMENT (avant l'attente de l'env) : une reprise concurrente de la même
  // session doit être rejetée tout de suite, et la session doit être annulable pendant son démarrage.
  pending.set(st.launchKey, st);
  if (id) live.set(id, st); // reprise : l'id est connu d'avance, la session est pilotable tout de suite

  // Le prompt initial est mis en file TOUT DE SUITE : le SDK bufferise l'entrée jusqu'à ce que le CLI
  // soit prêt. Plus d'attente de composer, plus de dialogue de confiance à accepter, plus de fenêtre
  // de détection de collage — tout ce que l'ancien launchSession devait contourner à l'écran.
  const seed = prompt && typeof prompt === 'string' ? prompt.trim() : '';
  if (seed) input.push(userMessage(seed));

  // On attend l'environnement du shell de login (résolu une fois, déjà chaud en pratique) avant de
  // spawner : sans lui la session perdrait le PATH et les variables du profil (cf. loginEnv).
  loginEnv().then((env) => {
    if (st.abort.signal.aborted) return; // tuée pendant le démarrage
    try {
      st.q = query({ prompt: input, options: sdkOptions({ cwd: dir, model, effort, permissionMode, resumeId: id, worktree: useWorktree, input, st, env }) });
    } catch (e) {
      st.error = 'agent sdk query failed: ' + ((e && e.message) || e);
      failStartup(st);
      return;
    }
    // Chien de garde de DÉMARRAGE : un CLI qui ne produit aucun message n'a pas démarré. Sans ça
    // l'entrée reste dans `live` avec ended:false, readLoop attend un flux qui ne viendra jamais, et
    // deliverReply pousse dans une file que personne ne vide — l'envoi répond OK et le message est
    // perdu en silence. Cas réel : reprise au boot alors qu'un CLI orphelin d'un hooked précédent
    // tenait encore le verrou de la session. Ne surveille QUE le premier message : une session
    // saine, elle, peut rester silencieuse aussi longtemps qu'elle veut.
    st.watchdog = setTimeout(() => {
      if (st.sawMsg || st.ended) return;
      st.error = `session produced no output within ${INIT_TIMEOUT / 1000}s`;
      failStartup(st);
    }, INIT_TIMEOUT);
    st.watchdog.unref?.();
    readLoop(st);
  });

  const done = (finalSt) => {
    if (finalSt.error) return cb(new Error('agent sdk session failed: ' + finalSt.error));
    if (!finalSt.id) return cb(new Error('agent sdk session ended before reporting its id'));
    persistLaunch(finalSt.id, model, effort);
    try {
      fs.appendFileSync(LAUNCHES_FILE, JSON.stringify({
        ts: new Date().toISOString(), session_id: finalSt.id, cwd: finalSt.cwd,
        model: model || null, effort: effort || null, worktree: useWorktree,
      }) + '\n');
    } catch (_) {}
    cb(null, {
      sessionId: finalSt.id,
      cwd: finalSt.cwd,
      resume: id,
      worktree: useWorktree,
      link: '/session/' + encodeURIComponent(finalSt.id),
    });
  };

  if (st.id) {
    // Reprise : id connu, on rend la main sans attendre le `system/init`.
    persistLaunch(st.id, model, effort);
    return done(st);
  }
  // Session neuve : on attend le `system/init` pour connaître le session_id (et le vrai cwd quand
  // `--worktree` a déplacé la session). L'ancien code ne pouvait pas le faire et renvoyait un nom
  // de session tmux à la place — le deep-link vers la session est un gain de la migration.
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    st.onInit = null;
    cb(new Error(`agent sdk session did not start within ${INIT_TIMEOUT / 1000}s`));
  }, INIT_TIMEOUT);
  st.onInit = (finalSt) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done(finalSt);
  };
}

// La session est-elle vivante dans CE processus ? (remplace tmuxAlive)
function agentAlive(id) {
  const st = id ? live.get(id) : null;
  return !!(st && !st.ended);
}

// Session pilotable : vivante ET dont le sous-processus est réellement démarré (`st.q` existe).
// Entre le POST /api/launch et la résolution de l'env du shell de login, une session est déjà dans le
// registre mais n'a pas encore de canal de contrôle — un interrupt/setMode à cet instant planterait
// sur `st.q` undefined. Les LECTURES d'état (agentBusy…) n'ont pas ce besoin et passent par
// agentSession.
function drivableSession(id) {
  const st = agentSession(id);
  return st && st.q ? st : null;
}

function agentSession(id) {
  const st = id ? live.get(id) : null;
  return st && !st.ended ? st : null;
}

// Ids des sessions vivantes (pour la vue globale des jobs de fond, notamment).
function liveSessionIds() {
  const out = [];
  for (const [id, st] of live) if (!st.ended) out.push(id);
  return out;
}

// ── Lectures d'état (ex-lectures de pane) ────────────────────────────────────────────────────────
function agentBusy(id) { const st = agentSession(id); return st ? !!st.busy : null; }
function agentActivity(id) { const st = agentSession(id); return st ? st.activity : null; }
function agentFollowup(id) { const st = agentSession(id); return st ? st.followup : null; }
function agentLastProse(id) { const st = agentSession(id); return st ? st.lastProse : null; }
function agentMode(id) { const st = agentSession(id); return st ? st.permissionMode : null; }
function agentAutoApprove(id) { const st = agentSession(id); return st ? !!st.autoApprove : false; }
// Attente en cours, sous une forme sérialisable (sans le resolver).
function agentPendingAsk(id) {
  const st = agentSession(id);
  if (!st || !st.pendingAsk) return null;
  const a = st.pendingAsk;
  return {
    kind: a.kind, id: a.id, toolName: a.toolName || null,
    questions: a.questions || null, plan: a.plan || null, input: a.input || null,
    reason: a.reason || null, askRule: a.askRule || null,
  };
}

// ── Réponses & pilotage ──────────────────────────────────────────────────────────────────────────

// Envoie un message dans la session. `text` peut être un tableau (une entrée par question d'un
// ancien AskUserQuestion multi-écrans) : on pousse chaque entrée comme un message distinct, le SDK
// les met en file et Claude les traite dans l'ordre.
// ── Mode bash du composer (`!commande`) ──────────────────────────────────────────────────────────
// Dans le TUI de Claude Code, un « ! » en tête de saisie bascule en mode bash : la commande est
// exécutée localement et sa sortie rejoint le contexte, sans faire répondre le modèle. Du temps de
// tmux, hooked héritait de ce comportement gratuitement — le texte était tapé dans le TUI, qui s'en
// chargeait. En entrée stream-json le CLI ne l'interprète plus (mesuré : `!echo x` part au modèle
// comme du texte ordinaire), donc hooked doit le faire lui-même.
const LOCAL_CMD_TIMEOUT = 120000;   // garde-fou : une commande qui pend ne doit pas retenir la requête
const LOCAL_CMD_MAX_OUTPUT = 60000; // borne la sortie injectée dans le contexte (un `find /` déborderait)

// Extrait la commande d'une saisie en mode bash, ou null si ce n'en est pas une. Pur/testable.
// Strict : un « ! » de tête suivi d'au moins un caractère non blanc. Un texte qui commence par
// « !! » ou « ! » seul n'en est pas une — on n'attrape pas une exclamation de prose par erreur.
function parseBangCommand(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/^!\s*(\S[\s\S]*)$/);
  if (!m) return null;
  const cmd = m[1].trim();
  return cmd && !cmd.startsWith('!') ? cmd : null;
}

// Séquences d'échappement ANSI (couleurs, déplacements de curseur, titre de fenêtre). Les outils
// les omettent d'ordinaire ici — `spawn` sans PTY laisse `isatty()` faux, donc la couleur est
// désactivée — mais un `FORCE_COLOR` dans le profil de l'utilisateur suffit à les faire réapparaître.
// On les retire : elles ne veulent rien dire ni pour Claude, ni pour un bloc rendu en HTML.
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[=>()][0-9A-Za-z]?/g;
const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

// Met en forme le compte rendu injecté dans le contexte de la session. Pur/testable.
//
// C'est un BLOC DE CODE FENCÉ `console`, avec le code de sortie et le dossier dans l'info-string.
// Deux lecteurs, un seul format : Claude y lit une transcription de terminal on ne peut plus
// ordinaire, et l'UI reconnaît le langage `console` pour rendre la bulle comme un terminal (cf.
// TerminalBlock.svelte) au lieu d'un paragraphe de texte. Avant, l'en-tête était de la prose
// (« Local command (…exit 0) »), donc le front aurait dû reconnaître une phrase — fragile, et
// impossible à distinguer d'un utilisateur qui l'aurait tapée.
function formatLocalCommand(command, code, output, truncated, cwd) {
  const info = ['console', `exit=${code}`];
  if (cwd) info.push(`cwd=${cwd}`);
  if (truncated) info.push('truncated=1');
  const body = stripAnsi(output || '').replace(/\n+$/, '');
  // Une fence dont le CONTENU contient ``` casserait le bloc : on allonge le délimiteur au besoin.
  const longest = (body.match(/`{3,}/g) || []).reduce((m, r) => Math.max(m, r.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info.join(' ')}\n$ ${command}\n${body}\n${fence}`;
}

// Exécute la commande dans le dossier de la session, avec l'environnement du shell de login (le même
// que la session elle-même, cf. loginEnv) — sinon `mise`, `kubectl` ou `gh` seraient introuvables.
// `sh -c` est volontaire : l'utilisateur A ÉCRIT une ligne de shell, on veut ses pipes et ses
// redirections. Ce n'est pas une surface d'injection — c'est la saisie de l'utilisateur, sur une
// interface liée à localhost, dans une session qui peut déjà tout faire.
function runLocalCommand(id, command, cb) {
  const st = agentSession(id);
  if (!st) return cb(err400('no live agent session for this id'));
  if (!command) return cb(err400('command required'));
  const startedAt = Date.now();
  loginEnv().then((env) => {
    let out = '';
    let done = false;
    const child = spawn(process.env.SHELL || '/bin/sh', ['-c', command], {
      cwd: st.cwd,
      env: { ...process.env, ...env },
    });
    const timer = setTimeout(() => { if (!done) { try { child.kill('SIGKILL'); } catch (_) {} } }, LOCAL_CMD_TIMEOUT);
    const grab = (chunk) => { if (out.length < LOCAL_CMD_MAX_OUTPUT) out += String(chunk); };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);   // fusionnés : c'est ce qu'on lit dans un terminal
    child.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      cb(new Error('failed to run the command: ' + (e.message || e)));
    });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      const truncated = out.length > LOCAL_CMD_MAX_OUTPUT;
      const output = truncated ? out.slice(0, LOCAL_CMD_MAX_OUTPUT) : out;
      // `shouldQuery: false` : la sortie rejoint le contexte SANS déclencher de tour modèle —
      // exactement le comportement du mode bash du TUI. Sans ça, chaque `!ls` ferait répondre Claude.
      st.input.push({ ...userMessage(formatLocalCommand(command, code, output, truncated, st.cwd)), shouldQuery: false });
      cb(null, {
        sessionId: id,
        localCommand: { command, code, output, truncated, durationMs: Date.now() - startedAt, cwd: st.cwd },
      });
    });
  }).catch((e) => cb(new Error('failed to resolve the login environment: ' + ((e && e.message) || e))));
}

function deliverReply(id, text, cb) {
  const st = agentSession(id);
  if (!st) return cb(err400('no live agent session for this id'));
  // Une session qui n'a pas encore produit son premier message n'est pas prête : y pousser un texte
  // le mettrait dans une file que personne ne vide, en répondant OK. Mieux vaut un refus explicite
  // et un nouvel essai qu'un message perdu en silence (cf. le chien de garde de démarrage).
  if (!st.sawMsg) return cb(err400('session is still starting — try again in a moment'));
  const parts = (Array.isArray(text) ? text : [text])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);
  if (!parts.length) return cb(err400('text required'));
  // Mode bash : `!commande` s'exécute localement au lieu de partir au modèle (cf. runLocalCommand).
  // Seulement sur une saisie SIMPLE — un envoi multiple est une file de messages, pas une commande.
  if (parts.length === 1) {
    const bang = parseBangCommand(parts[0]);
    if (bang) return runLocalCommand(id, bang, cb);
  }
  for (const p of parts) {
    if (!st.input.push(userMessage(p))) return cb(new Error('session input closed'));
  }
  st.busy = true;
  st.followup = null; // la suggestion précédente n'a plus de sens
  cb(null, { sessionId: id, sent: parts.length });
}

// Résout la réponse à un AskUserQuestion. `selections` = [{ multi, indices }] dans l'ordre des
// questions ; `note` = commentaire libre optionnel, envoyé en message de suivi.
//
// Plus de navigation clavier (↓/Entrée/→) ni de délais anti-coalescence d'ink : on remet l'input du
// tool_use à Claude avec le champ `answers` que la couche permission remplit normalement.
function answerQuestion(id, selections, note, cb) {
  if (typeof note === 'function') { cb = note; note = ''; }
  const st = agentSession(id);
  if (!st) return cb(err400('no live agent session for this id'));
  const ask = st.pendingAsk;
  if (!ask || ask.kind !== 'question') return cb(err400('no question awaiting an answer for this session'));
  if (!Array.isArray(selections) || !selections.length) return cb(err400('selections required'));

  const questions = ask.questions || [];
  const answers = {};
  selections.forEach((sel, i) => {
    const q = questions[i];
    if (!q) return;
    const idx = (Array.isArray(sel && sel.indices) ? sel.indices : [])
      .filter((n) => Number.isInteger(n) && n >= 0 && n < (q.options || []).length)
      .sort((a, b) => a - b);
    const labels = idx.map((n) => q.options[n].label);
    if (!labels.length) return;
    // multi-select : réponses séparées par des virgules (format attendu par le tool).
    answers[q.question] = sel && sel.multi ? labels.join(', ') : labels[0];
  });
  if (!Object.keys(answers).length) return cb(err400('empty selections'));

  const n = typeof note === 'string' ? note.trim() : '';
  const resolve = ask.resolve;
  resolve({ behavior: 'allow', updatedInput: { ...(ask.input || {}), answers } });
  if (n) st.input.push(userMessage(n)); // la note part comme message de suivi, comme avant
  cb(null, { sessionId: id, answers });
}

// Réponse en TEXTE LIBRE à une question en attente : l'utilisateur a rejeté les options proposées.
// On la passe comme valeur de réponse pour la première question — l'ancien chemin devait envoyer
// Échap pour fermer le widget puis taper le texte, parce qu'un widget de sélection avale les
// caractères tapés ; ici le champ `answers` accepte n'importe quelle chaîne.
function answerQuestionFreeText(id, text, cb) {
  const st = agentSession(id);
  if (!st) return cb(err400('no live agent session for this id'));
  const ask = st.pendingAsk;
  const answer = (Array.isArray(text) ? text.join('\n') : String(text || '')).trim();
  if (!answer) return cb(err400('text required'));
  if (!ask || ask.kind !== 'question') {
    // Plus de question en attente (déjà résolue entre-temps) → message normal.
    return deliverReply(id, answer, cb);
  }
  const first = (ask.questions || [])[0];
  const answers = first ? { [first.question]: answer } : {};
  ask.resolve({ behavior: 'allow', updatedInput: { ...(ask.input || {}), answers } });
  cb(null, { sessionId: id, freeText: true });
}

// Actions possibles sur un plan ExitPlanMode en attente (mêmes noms qu'avant, pour ne rien casser
// côté UI). `approve*` autorise la sortie du mode plan et pousse le mode de permission cible ;
// `keep*` refuse : Claude reste en mode plan et reçoit le feedback comme raison du refus.
const PLAN_ACTIONS = ['approve', 'approve-auto', 'keep', 'keep-feedback'];
function answerPlan(id, action, feedback, cb) {
  if (typeof feedback === 'function') { cb = feedback; feedback = ''; }
  const st = drivableSession(id);
  if (!st) return cb(err400('session not driving yet (still starting?) or not live'));
  if (!PLAN_ACTIONS.includes(action)) return cb(err400('unknown action: ' + action));
  const fb = typeof feedback === 'string' ? feedback.trim() : '';
  if (action === 'keep-feedback' && !fb) return cb(err400('feedback required'));
  const ask = st.pendingAsk;
  if (!ask || ask.kind !== 'plan') return cb(err400('no plan awaiting approval for this session'));

  if (action === 'approve' || action === 'approve-auto') {
    const target = action === 'approve-auto' ? 'auto' : 'acceptEdits';
    ask.resolve({ behavior: 'allow' });
    // Après l'approbation, on épingle le mode d'exécution demandé (l'équivalent des options
    // « Yes, auto-accept edits » / « Yes, and use auto mode » du menu du TUI).
    st.q.setPermissionMode(target).then(() => { st.permissionMode = target; }).catch(() => {});
    return cb(null, { sessionId: id, action, mode: target });
  }
  // keep / keep-feedback : refus. Le message de refus est ce que Claude lit → c'est là que va le
  // feedback (l'ancien chemin le tapait en message séparé après le refus).
  const message = fb || 'Keep planning: the plan was not approved yet.';
  ask.resolve({ behavior: 'deny', message });
  cb(null, { sessionId: id, action });
}

// Répond à une demande de permission d'outil (le 3ᵉ type d'attente). `choice` : 'allow' |
// 'allow-always' | 'deny'. Répondable depuis le web, ce qui n'était possible avant que dans le TUI.
function answerPermission(id, choice, message, cb) {
  if (typeof message === 'function') { cb = message; message = ''; }
  const st = agentSession(id);
  if (!st) return cb(err400('no live agent session for this id'));
  const ask = st.pendingAsk;
  if (!ask || ask.kind !== 'permission') return cb(err400('no permission request awaiting an answer'));
  if (choice === 'deny') {
    ask.resolve({ behavior: 'deny', message: (typeof message === 'string' && message.trim()) || 'Denied from the hooked dashboard.' });
    return cb(null, { sessionId: id, choice });
  }
  if (choice === 'allow-always') {
    ask.resolve({ behavior: 'allow', updatedPermissions: alwaysAllowRules(ask.toolName, ask.suggestions) });
    return cb(null, { sessionId: id, choice });
  }
  if (choice !== 'allow') return cb(err400('unknown choice: ' + choice));
  ask.resolve({ behavior: 'allow' });
  cb(null, { sessionId: id, choice });
}

// Aiguillage d'une réponse par SÉLECTION vers la bonne attente : question, plan ou permission.
// L'UI web n'a qu'un seul chemin de réponse (le composant Question) ; c'est ici qu'on démultiplexe.
function answerPendingSelection(id, selections, note, cb) {
  const st = agentSession(id);
  if (!st) return cb(err400('no live agent session for this id'));
  const ask = st.pendingAsk;
  if (!ask) return cb(err400('nothing awaiting an answer for this session'));
  if (ask.kind === 'question') return answerQuestion(id, selections, note, cb);
  if (ask.kind === 'permission') {
    const first = Array.isArray(selections) ? selections[0] : null;
    const i = first && Array.isArray(first.indices) ? first.indices[0] : -1;
    const choice = i === 0 ? 'allow' : i === 1 ? 'allow-always' : i === 2 ? 'deny' : null;
    if (!choice) return cb(err400('invalid permission selection'));
    return answerPermission(id, choice, note, cb);
  }
  return cb(err400('the pending item is a plan: use /api/plan'));
}

// Interrompt Claude (Échap dans le TUI). Le SDK n'a pas le problème de « prompt réinjecté dans la
// saisie » que l'ancien code devait nettoyer avec deux Échap : la file d'entrée est la nôtre.
function interruptSession(id, cb) {
  const st = drivableSession(id);
  if (!st) return cb(err400('no live agent session for this id'));
  // Une attente en cours est annulée : la laisser bloquée après un interrupt figerait la session.
  if (st.pendingAsk) {
    const r = st.pendingAsk.resolve;
    st.pendingAsk = null;
    try { r({ behavior: 'deny', message: 'Interrupted from the hooked dashboard.' }); } catch (_) {}
  }
  st.q.interrupt().then((receipt) => {
    st.busy = false;
    st.activity = null;
    cb(null, { sessionId: id, receipt: receipt || null });
  }).catch((e) => cb(new Error('interrupt failed: ' + ((e && e.message) || e))));
}

// Active / coupe l'auto-approbation des outils pour une session. C'est l'interrupteur « je veux
// travailler en continu » : les demandes de permission cessent, les questions et les plans
// continuent d'arriver. Volontairement porté par la SESSION (pas un réglage global) : c'est une
// décision de confiance qui vaut pour ce chantier-là.
//
// Si une demande de permission est DÉJÀ en attente au moment où on l'active, on la débloque tout de
// suite — sinon l'utilisateur active l'auto et reste quand même planté sur la carte affichée.
function setAutoApprove(id, on, cb) {
  const st = agentSession(id);
  if (!st) return cb(err400('no live agent session for this id'));
  st.autoApprove = !!on;
  if (st.autoApprove && st.pendingAsk && st.pendingAsk.kind === 'permission') {
    const r = st.pendingAsk.resolve;
    st.pendingAsk = null;
    try { r({ behavior: 'allow' }); } catch (_) {}
    st.sdkState = 'running';
    st.busy = true;
  }
  cb(null, { sessionId: id, autoApprove: st.autoApprove });
}

// Change le mode de permission. Plus de boucle fermée Maj+Tab + relecture du footer : un appel.
function setMode(id, target, cb) {
  const st = drivableSession(id);
  if (!st) return cb(err400('no live agent session for this id'));
  if (!PERMISSION_MODES.includes(target)) return cb(err400('unknown mode: ' + target));
  st.q.setPermissionMode(target).then(() => {
    st.permissionMode = target;
    cb(null, { sessionId: id, mode: target });
  }).catch((e) => cb(new Error('setPermissionMode failed: ' + ((e && e.message) || e))));
}

// Change modèle et/ou effort. Plus de `/model` tapé au clavier ni de dialogue de confirmation
// « la conversation va être relue » à piloter : deux requêtes de contrôle.
function setModelEffort(id, { model, effort } = {}, cb) {
  const st = drivableSession(id);
  if (!st) return cb(err400('no live agent session for this id'));
  if (model && !isValidModelArg(model)) return cb(err400('unknown model: ' + model));
  if (effort && !isValidEffort(effort)) return cb(err400('unknown effort: ' + effort));
  if (!model && !effort) return cb(err400('model or effort required'));
  const steps = [];
  if (model) steps.push(st.q.setModel(model).then(() => { st.model = model; st.launchModel = model; }));
  if (effort) steps.push(st.q.applyFlagSettings({ effortLevel: effort }).then(() => { st.effort = effort; st.launchEffort = effort; }));
  Promise.all(steps).then(() => {
    const prev = sessionLaunchMap().get(id) || {};
    persistLaunch(id, model || prev.model || null, effort || prev.effort || null);
    cb(null, { sessionId: id, model: model || null, effort: effort || null });
  }).catch((e) => cb(new Error('model/effort change failed: ' + ((e && e.message) || e))));
}

// Stoppe la session : on ferme la file d'entrée puis on avorte. La boucle de lecture nettoie.
function killSession(id, cb) {
  const st = agentSession(id);
  if (!st) return cb(err400('no live agent session for this id'));
  st.input.close();
  st.abort.abort();
  st.ended = true;
  live.delete(id);
  cb(null, { sessionId: id });
}

// Redémarre une session pour qu'elle reparte sur la version claude installée : on termine le
// process courant, puis on relance en reprise. L'état mémoire est volontairement perdu ; la reprise
// recharge le transcript (philosophie « reconnect » du projet).
function restartSession(id, { model, effort } = {}, cb) {
  const st = agentSession(id);
  const relaunch = () => launchSession({ resumeId: id, model, effort }, cb);
  if (!st) return relaunch();
  st.input.close();
  st.abort.abort();
  st.ended = true;
  live.delete(id);
  setTimeout(relaunch, 250); // laisser le sous-processus rendre le verrou de session
}

// ── Reprise après un redémarrage de hooked ───────────────────────────────────────────────────────
//
// Les sessions vivent dans CE processus, donc `mise deploy` (launchd kickstart -k) les tue toutes —
// c'est le compromis assumé du modèle « hooked possède le process », et le plus gros irritant au
// quotidien. On tient donc un instantané du jeu piloté sur disque et on le rejoue au démarrage.
// Le tour en cours est perdu (il ne nous a jamais appartenu), mais les sessions redeviennent
// pilotables sans aller les repêcher une par une.

const DRIVEN_MAX = 6;                     // chaque reprise = un process claude, on borne le boot
const DRIVEN_FRESH_MS = 12 * 3600 * 1000; // hooked éteint plus longtemps → on ne réveille rien
const SNAPSHOT_MS = 10000;

// Choisit ce qui mérite d'être repris. Pure et exportée : c'est la seule partie qui décide, et la
// tester ne doit pas demander de lancer une vraie session.
function pickResumable(snap, now = Date.now()) {
  const list = snap && Array.isArray(snap.sessions) ? snap.sessions : [];
  if (!list.length) return [];
  // Un instantané sans date ou périmé ne dit plus rien de l'intention de l'utilisateur.
  const ts = Date.parse((snap && snap.ts) || '');
  if (!Number.isFinite(ts) || now - ts > DRIVEN_FRESH_MS || now - ts < 0) return [];
  return list.filter((s) => s && typeof s.id === 'string' && s.id && typeof s.cwd === 'string' && s.cwd)
    .slice(0, DRIVEN_MAX);
}

function drivenSnapshot() {
  const out = [];
  for (const [id, st] of live) {
    if (!id || st.ended) continue;
    out.push({
      id, cwd: st.cwd, model: st.launchModel || null, effort: st.launchEffort || null,
      permissionMode: st.permissionMode || null, autoApprove: !!st.autoApprove,
    });
  }
  return out;
}

// ponytail: instantané par sondage (10 s) plutôt que sur chaque mutation du registre — `live` est
// muté depuis six endroits (lancement, init, kill, restart, échec, fin de readLoop) et en oublier un
// donnerait un fichier faux, ce qui est pire qu'une fenêtre de 10 s. Passer à un `setLive/dropLive`
// centralisé si la fenêtre devient un problème.
let lastDriven = null;
function saveDriven() {
  const sessions = drivenSnapshot();
  const body = JSON.stringify(sessions);
  if (body === lastDriven) return; // rien n'a changé : pas d'écriture
  lastDriven = body;
  try { fs.writeFileSync(DRIVEN_FILE, JSON.stringify({ ts: new Date().toISOString(), sessions })); } catch (_) {}
}

const SNAPSHOT_TIMER = Symbol.for('hooked.agent.snapshotTimer');
function startDrivenSnapshot() {
  if (globalThis[SNAPSHOT_TIMER]) return;
  const t = setInterval(saveDriven, SNAPSHOT_MS);
  t.unref?.(); // ne doit jamais retenir le processus à la sortie
  globalThis[SNAPSHOT_TIMER] = t;
}

// Relance les sessions pilotées au moment du dernier arrêt. Séquentiel et espacé : chaque reprise
// spawne un CLI qui relit son transcript, les lancer d'un bloc ferait un pic pour rien. Aucun prompt
// n'est poussé, donc aucun tour n'est consommé — la session repart et attend.
function resumeDrivenSessions(cb) {
  const done = typeof cb === 'function' ? cb : () => {};
  if (process.env.HOOKED_NO_RESUME) return done(null, { resumed: 0, skipped: 'HOOKED_NO_RESUME' });
  let snap = null;
  try { snap = JSON.parse(fs.readFileSync(DRIVEN_FILE, 'utf8')); } catch (_) { return done(null, { resumed: 0 }); }
  const take = pickResumable(snap);
  if (!take.length) return done(null, { resumed: 0 });
  const failed = [];
  let i = 0;
  const next = () => {
    const s = take[i++];
    if (!s) return done(null, { resumed: take.length - failed.length, failed });
    launchSession({
      resumeId: s.id, cwd: s.cwd, model: s.model, effort: s.effort,
      permissionMode: s.permissionMode || undefined, autoApprove: s.autoApprove,
    }, (err) => {
      if (err) failed.push({ id: s.id, error: (err && err.message) || String(err) });
      setTimeout(next, 1500);
    });
  };
  next();
}

// Purge l'état volatil dérivé du flux (activité / suggestion) pour toutes les sessions vivantes :
// utilisé par le resync manuel des Réglages, qui servait avant à vider les caches de capture tmux.
function clearAgentState() {
  for (const st of live.values()) { st.activity = null; st.followup = null; }
}

export {
  agentAlive, agentSession, liveSessionIds,
  agentBusy, agentActivity, agentFollowup, agentLastProse, agentMode, agentAutoApprove, agentPendingAsk,
  applyMessage, permissionQuestion, handleToolPermission, makeInputQueue, userMessage, parseEnvBlock, loginEnv,
  subscribeAgent, streamSnapshot,
  resolveLaunchForSession, sessionLaunchMap,
  launchSession, killSession, restartSession,
  deliverReply, answerQuestion, answerQuestionFreeText, answerPlan, answerPermission, answerPendingSelection,
  interruptSession, setMode, setModelEffort, setAutoApprove, alwaysAllowRules, clearAgentState,
  resumeDrivenSessions, startDrivenSnapshot, pickResumable, saveDriven, failStartup,
  parseBangCommand, formatLocalCommand, stripAnsi, runLocalCommand,
  PLAN_ACTIONS, err400,
};
