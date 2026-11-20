/*
 * Driver Mistral Vibe (provider "vibe") — pilotage des sessions via ACP (Agent Client Protocol).
 * cf. docs/port-vibe.md (phase M1).
 *
 * Chaque session pilotée = un process `vibe-acp` spawned, avec lequel on parle JSON-RPC 2.0
 * newline-delimited sur stdio (transport ACP standard) :
 *   client → agent : initialize, session/new, session/load, session/prompt, session/cancel,
 *                    session/set_mode, session/set_config_option (model/thinking), session/close
 *   agent → client : réponses + notifications `session/update` (agent_message_chunk, tool_call,
 *                    tool_call_update…) + requêtes `session/request_permission` (approbations)
 *                    et `elicitation/create` (questions utilisateur).
 *
 * Le registre d'état (st) est le MÊME que celui d'agent.js (champs partagés : busy, sdkState,
 * pendingAsk {kind, resolve}, activity, lastProse…) : agent.js dispatche vers ce module quand
 * st.provider === 'vibe'. `ask.resolve` garde le contrat hooked ({behavior:'allow'|'deny', …})
 * et traduit ici en réponse ACP.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const err400 = (msg) => Object.assign(new Error(msg), { code: 400 });

// Sentinel : le handler d'une requête entrante répondra plus tard (réponse différée).
const ACP_DEFER = Symbol('acp-defer');

// Lu au spawn (pas au chargement du module) : les tests pointent HOOKED_VIBE_ACP_BIN sur un
// faux serveur ACP.
const acpBin = () => process.env.HOOKED_VIBE_ACP_BIN || 'vibe-acp';
const RPC_TIMEOUT = 120_000; // un prompt peut durer longtemps ; le timeout porte sur l'init/new

// ---------------------------------------------------------------------------
// Client ACP minimal (stdio, JSON-RPC 2.0 newline-delimited)
// ---------------------------------------------------------------------------
class AcpClient {
  constructor(cmd, args, { cwd, env }) {
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.onNotification = null; // (method, params)
    this.onRequest = null;      // (id, method, params) -> result | { __error }
    this.proc = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) this._handleLine(line);
      }
    });
    this.proc.stderr.on('data', () => {}); // logs vibe : on les avale (jamais bloquant)
    this.proc.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`vibe-acp exited (${code})`));
      this.pending.clear();
      if (this.onExit) this.onExit(code);
    });
  }

  _handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || 'ACP error'));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.id !== undefined && msg.method) {
      // requête entrante de l'agent (request_permission, elicitation/create, fs/*, terminal/*).
      // Le handler rend ACP_DEFER quand la réponse partira plus tard (via ask.resolve).
      let result;
      try { result = this.onRequest ? this.onRequest(msg.id, msg.method, msg.params || {}) : { __error: { code: -32601, message: 'unsupported client method' } }; }
      catch (e) { result = { __error: { code: -32603, message: String((e && e.message) || e) } }; }
      if (result === ACP_DEFER) return;
      if (result && result.__error) this._send({ jsonrpc: '2.0', id: msg.id, error: result.__error });
      else this._send({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? {} : result });
      return;
    }
    if (msg.method && this.onNotification) this.onNotification(msg.method, msg.params || {});
  }

  _send(obj) {
    try { this.proc.stdin.write(JSON.stringify(obj) + '\n'); } catch (_) {}
  }

  call(method, params, timeoutMs = RPC_TIMEOUT) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  close() {
    try { this.proc.kill('SIGTERM'); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Mapping modes hooked → agents Vibe (session/set_mode)
// ---------------------------------------------------------------------------
const VIBE_MODE_BY_HOOKED = {
  default: 'ask',
  acceptEdits: 'accept-edits',
  auto: 'auto-approve',
  bypassPermissions: 'auto-approve',
  dontAsk: 'auto-approve',
  plan: 'ask', // pas d'équivalent « plan mode » côté Vibe : on reste en ask (documenté, M4)
};
function vibeModeFor(hookedMode) { return VIBE_MODE_BY_HOOKED[hookedMode] || 'ask'; }

// ---------------------------------------------------------------------------
// Session pilotée
// ---------------------------------------------------------------------------

// Traduit une réponse hooked de question (selections [{multi, indices, other}]) en `content`
// elicitation ACP ({q0: 'label', q1: ['a','b'], …}).
function elicitationContent(questions, selections) {
  const content = {};
  (questions || []).forEach((q, i) => {
    const sel = Array.isArray(selections) ? selections[i] : null;
    const opts = (q.options || []).map((o) => o.label);
    if (sel && typeof sel.other === 'string' && sel.other) { content[`q${i}`] = sel.other; return; }
    const idx = sel && Array.isArray(sel.indices) ? sel.indices.filter((n) => Number.isInteger(n) && n >= 0 && n < opts.length) : [];
    if (q.multiSelect) content[`q${i}`] = idx.map((n) => opts[n]);
    else if (idx.length) content[`q${i}`] = opts[idx[0]];
    else if (opts.length) content[`q${i}`] = opts[0];
  });
  return content;
}

// Construit les questions hooked depuis le schéma d'elicitation ACP.
function questionsFromSchema(schema) {
  const props = (schema && schema.properties) || {};
  return Object.keys(props).sort().map((key) => {
    const p = props[key] || {};
    const oneOf = p.oneOf || p.one_of || (p.items && (p.items.anyOf || p.items.any_of)) || [];
    return {
      question: p.description || key,
      header: p.title || '',
      multiSelect: p.type === 'array',
      options: oneOf.map((o) => ({ label: o.title || o.const || String(o) })),
    };
  });
}

function pickOption(options, ...ids) {
  for (const id of ids) {
    const o = (options || []).find((x) => x.option_id === id);
    if (o) return o.option_id;
  }
  return (options && options[0] && options[0].option_id) || null;
}

// Gère une requête entrante de l'agent (approbation / question / non supporté).
function handleAgentRequest(st, client, reqId, method, params) {
  if (method === 'session/request_permission') {
    const tc = params.toolCall || params.tool_call || {};
    const tcId = tc.toolCallId || tc.tool_call_id || null;
    const toolName = (st._toolNames && st._toolNames[tcId]) || tc.title || tc.toolName || tcId || 'tool';
    const options = (params.options || []).map((o) => ({ ...o, option_id: o.option_id || o.optionId }));
    const ask = {
      kind: 'permission',
      id: 'acp:' + reqId,
      toolName,
      options,
      resolve: null, // posé juste après (wrapper qui clear le registre)
    };
    const rawResolve = (resp) => {
      const deny = !resp || resp.behavior === 'deny';
      const option_id = deny
        ? pickOption(options, 'reject_once')
        : pickOption(options, resp.allowAlways ? 'allow_always_permanent' : 'allow_once', resp.allowAlways ? 'allow_always' : 'allow_once', 'allow_once');
      client._send({ jsonrpc: '2.0', id: reqId, result: { outcome: { outcome: 'selected', optionId: option_id } } });
    };
    ask.resolve = (resp) => {
      if (st.pendingAsk === ask) { st.pendingAsk = null; st.sdkState = 'running'; st.busy = true; }
      rawResolve(resp);
    };
    st.pendingAsk = ask;
    st.sdkState = 'requires_action';
    st.busy = false;
    if (st.autoApprove) { const r = ask.resolve; st.pendingAsk = null; r({ behavior: 'allow' }); }
    return ACP_DEFER; // réponse envoyée plus tard via ask.resolve
  }
  if (method === 'elicitation/create') {
    const mode = params.mode || {};
    const schema = mode.requestedSchema || mode.requested_schema || {};
    const questions = questionsFromSchema(schema);
    const ask = {
      kind: 'question',
      id: 'acp:' + reqId,
      questions,
      resolve: null,
    };
    const rawResolve = (resp) => {
      // resp hooked : { elicitation } (sélections) ou { freeTextAnswer } (texte libre)
      let result;
      if (resp && resp.elicitation) {
        result = resp.elicitation; // { action, content }
      } else if (resp && resp.freeTextAnswer) {
        const content = {};
        questions.forEach((q, i) => { content[`q${i}`] = i === 0 ? resp.freeTextAnswer : (q.options[0] || {}).label || ''; });
        result = { action: 'accept', content };
      } else {
        result = { action: 'decline' };
      }
      client._send({ jsonrpc: '2.0', id: reqId, result });
    };
    ask.resolve = (resp) => {
      if (st.pendingAsk === ask) { st.pendingAsk = null; st.sdkState = 'running'; st.busy = true; }
      rawResolve(resp);
    };
    st.pendingAsk = ask;
    st.sdkState = 'requires_action';
    st.busy = false;
    return ACP_DEFER;
  }
  return { __error: { code: -32601, message: `unsupported client method: ${method}` } };
}

// Notifications session/update → état live du registre (mêmes champs que le flux SDK).
function handleNotification(st, method, params) {
  if (method !== 'session/update') return;
  const u = params.update || {};
  const kind = u.sessionUpdate || u.session_update;
  st.lastMsgAt = Date.now();
  st.sawMsg = true;
  switch (kind) {
    case 'agent_message_chunk': case 'agentMessageChunk':
      if (u.chunk && typeof u.chunk.text === 'string' && u.chunk.text) st.lastProse = u.chunk.text.slice(0, 4000);
      break;
    case 'tool_call': case 'toolCall': {
      st.busy = true;
      if (!st.pendingAsk) st.sdkState = 'running';
      const raw = u.rawInput || u.raw_input || {};
      st.activity = u.title || raw.command || raw.file_path || 'tool';
      // index toolCallId → nom lisible, pour les request_permission (qui ne portent que l'id)
      const id = u.toolCallId || u.tool_call_id;
      if (id) { st._toolNames = st._toolNames || {}; st._toolNames[id] = st.activity; }
      break;
    }
    case 'tool_call_update': case 'toolCallUpdate':
      if (u.status === 'completed' || u.status === 'failed') st.activity = null;
      break;
    case 'available_commands_update': case 'availableCommandsUpdate': {
      // liste des commandes « / » déclarées par la session Vibe → auto-complétion du composer
      const cmds = u.availableCommands || u.available_commands || [];
      if (Array.isArray(cmds) && cmds.length) {
        st.vibeCommands = cmds.map((c) => ({ name: c.name, description: c.description || '' }));
      }
      break;
    }
    default:
      break;
  }
}

// Envoie un prompt (session/prompt). Résolu quand le tour se termine (stop_reason reçu).
function prompt(st, text) {
  const client = st.acp;
  if (!client || !st.acpSessionId) return Promise.reject(err400('vibe session not started'));
  st.busy = true;
  st.sdkState = 'running';
  st.activity = null;
  return client.call('session/prompt', {
    sessionId: st.acpSessionId,
    prompt: [{ type: 'text', text }],
  }, 3600_000).then((res) => {
    st.busy = false;
    if (!st.pendingAsk) st.sdkState = 'idle';
    return res;
  }).catch((e) => {
    st.busy = false;
    if (!st.pendingAsk) st.sdkState = 'idle';
    throw e;
  });
}

// Lance / reprend une session Vibe pilotée. `ctx` fournit les hooks d'agent.js :
// setLive(id, st), persistLaunch(id, model, effort), done(st), failStartup(st).
async function start(st, opts, ctx) {
  const env = opts.env || process.env;
  const client = new AcpClient(acpBin(), [], { cwd: st.cwd, env });
  st.acp = client;
  st.provider = 'vibe';
  client.onNotification = (m, p) => handleNotification(st, m, p);
  client.onRequest = (id, m, p) => handleAgentRequest(st, client, id, m, p);
  client.onExit = () => {
    st.ended = true;
    st.busy = false;
    if (st.pendingAsk) { const r = st.pendingAsk.resolve; st.pendingAsk = null; try { r({ behavior: 'deny', message: 'vibe-acp exited' }); } catch (_) {} }
  };
  try {
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30_000);
    let sessionId;
    if (opts.resumeId) {
      // mcpServers est REQUIS par le schéma ACP (même vide) — sans ça session/load rend
      // « Invalid params » et la session n'est jamais chargée.
      await client.call('session/load', { cwd: st.cwd, sessionId: opts.resumeId, mcpServers: [] }, 60_000);
      sessionId = opts.resumeId;
    } else {
      const r = await client.call('session/new', { cwd: st.cwd, mcpServers: [] }, 60_000);
      sessionId = r && (r.sessionId || r.session_id);
    }
    if (!sessionId) throw new Error('vibe-acp returned no session id');
    st.id = sessionId;
    st.acpSessionId = sessionId;
    st.sawMsg = true;
    ctx.setLive(sessionId, st);
    if (opts.model) { try { await client.call('session/set_config_option', { sessionId, configId: 'model', value: opts.model }, 15_000); } catch (_) {} }
    if (opts.effort) { try { await client.call('session/set_config_option', { sessionId, configId: 'thinking', value: opts.effort }, 15_000); } catch (_) {} }
    const modeId = vibeModeFor(opts.permissionMode);
    if (modeId) { try { await client.call('session/set_mode', { sessionId, modeId }, 15_000); st.permissionMode = opts.permissionMode || 'default'; } catch (_) {} }
    ctx.persistLaunch(sessionId, opts.model || null, opts.effort || null);
    if (opts.prompt && String(opts.prompt).trim()) {
      prompt(st, String(opts.prompt).trim()).catch(() => {}); // le tour tourne en fond ; l'état passe par session/update
    }
    ctx.done(st);
  } catch (e) {
    st.error = 'vibe-acp start failed: ' + ((e && e.message) || e);
    client.close();
    ctx.failStartup(st);
  }
}

function cancel(st) {
  if (st.acp && st.acpSessionId) return st.acp.call('session/cancel', { sessionId: st.acpSessionId }, 15_000).catch(() => {});
  return Promise.resolve();
}

function setMode(st, target) {
  const modeId = vibeModeFor(target);
  return st.acp.call('session/set_mode', { sessionId: st.acpSessionId, modeId }, 15_000)
    .then(() => { st.permissionMode = target; });
}

function setConfig(st, { model, thinking }) {
  const calls = [];
  if (model) calls.push(st.acp.call('session/set_config_option', { sessionId: st.acpSessionId, configId: 'model', value: model }, 15_000));
  if (thinking) calls.push(st.acp.call('session/set_config_option', { sessionId: st.acpSessionId, configId: 'thinking', value: thinking }, 15_000));
  return Promise.all(calls).then(() => {
    if (model) { st.model = model; st.launchModel = model; }
    if (thinking) { st.effort = thinking; st.launchEffort = thinking; }
  });
}

function kill(st) {
  if (st.acp) {
    st.acp.call('session/close', { sessionId: st.acpSessionId }, 5_000).catch(() => {});
    st.acp.close();
  }
  st.ended = true;
}

// Fork d'une session Vibe. Vibe verrouille chaque session par un file-lock (un seul process à la
// fois) : on ne peut NI forker depuis le process qui tient la source (lease interne en conflit),
// NI ouvrir la source depuis un second process tant qu'elle est live. Séquence donc :
//   1. si la source est live, on ferme sa connexion ACP (libère le lock) et on la rouvre ensuite
//      en arrière-plan via ctx.reopenSource ;
//   2. un process neuf fait session/load(source) + session/fork → newId, puis session/close(source)
//      pour rendre le lock de la source au process qui va la rouvrir ;
//   3. ce même process pilote le fork (il le détient déjà) — st.acp = ce client.
// opts: { cwd, prompt, model, effort, permissionMode, autoApprove, forkUuid }.
// ctx: { setLive(st), persistLaunch(id, m, e), liveSt?, reopenSource?(id) }.
async function vibeFork(id, opts, ctx) {
  const src = ctx.liveSt;
  const wasLive = !!(src && src.acp && src.acpSessionId && !src.ended);
  if (wasLive) {
    try { await src.acp.call('session/close', { sessionId: src.acpSessionId }, 10_000); } catch (_) {}
    src.forkClosing = true; // la fermeture déclenche onExit (ended=true) : flag pour autoriser le reopen
    src.acp.close();
    src.acp = null;
  }
  const reopen = () => { if (wasLive && ctx.reopenSource) ctx.reopenSource(id).catch(() => {}); };

  const client = new AcpClient(acpBin(), [], { cwd: opts.cwd, env: process.env });
  const st = {
    id: null, acp: client, acpSessionId: null, cwd: opts.cwd, provider: 'vibe',
    busy: false, sdkState: 'idle', pendingAsk: null, sawMsg: true, ended: false,
    autoApprove: opts.autoApprove !== false, abort: new AbortController(),
    input: { push: () => true, close: () => {} },
    activity: null, lastProse: null, followup: null,
    launchKey: 'fork:' + Date.now().toString(36),
    startedAt: new Date().toISOString(), lastMsgAt: Date.now(), lastRequestAt: null, lastUsage: null,
    model: opts.model || null, effort: opts.effort || null, launchModel: opts.model || null, launchEffort: opts.effort || null,
    permissionMode: opts.permissionMode || 'default',
  };
  client.onNotification = (m, p) => handleNotification(st, m, p);
  client.onRequest = (rid, m, p) => handleAgentRequest(st, client, rid, m, p);
  client.onExit = () => {
    st.ended = true; st.busy = false;
    if (st.pendingAsk) { const r = st.pendingAsk.resolve; st.pendingAsk = null; try { r({ behavior: 'deny', message: 'vibe-acp exited' }); } catch (_) {} }
  };
  try {
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30_000);
    await client.call('session/load', { cwd: opts.cwd, sessionId: id, mcpServers: [] }, 60_000);
    const r = await client.call('session/fork', { sessionId: id, cwd: opts.cwd, mcpServers: [], ...(opts.forkUuid ? { messageId: opts.forkUuid } : {}) }, 60_000);
    const newId = r && (r.sessionId || r.session_id);
    if (!newId) throw new Error('session/fork returned no session id');
    // Le fork est créé : on rend la source (son lock) pour qu'elle soit rouverte par un autre process.
    await client.call('session/close', { sessionId: id }, 10_000).catch(() => {});
    st.id = newId;
    st.acpSessionId = newId;
    ctx.setLive(st);
    if (opts.model) { try { await client.call('session/set_config_option', { sessionId: newId, configId: 'model', value: opts.model }, 15_000); } catch (_) {} }
    if (opts.effort) { try { await client.call('session/set_config_option', { sessionId: newId, configId: 'thinking', value: opts.effort }, 15_000); } catch (_) {} }
    const modeId = vibeModeFor(opts.permissionMode);
    if (modeId) { try { await client.call('session/set_mode', { sessionId: newId, modeId }, 15_000); } catch (_) {} }
    ctx.persistLaunch(newId, opts.model || null, opts.effort || null);
    reopen(); // rouvre la session d'origine en arrière-plan (elle était live)
    if (opts.prompt && String(opts.prompt).trim()) prompt(st, String(opts.prompt).trim()).catch(() => {});
    return { sessionId: newId, cwd: opts.cwd, forkedFrom: id };
  } catch (e) {
    client.close();
    reopen(); // ne pas laisser la source sans process si elle était live
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Options Vibe pour l'UI (modèles/thinking/agents lus depuis ~/.vibe/config.toml)
// ---------------------------------------------------------------------------
function readVibeConfig() {
  const home = process.env.VIBE_HOME || path.join(os.homedir(), '.vibe');
  const fp = process.env.HOOKED_VIBE_CONFIG || path.join(home, 'config.toml');
  try { return fs.readFileSync(fp, 'utf8'); } catch (_) { return ''; }
}

// Parse TOML minimal suffisant pour [[models]] (name/alias/thinking) et active_model.
function vibeOptions() {
  const toml = readVibeConfig();
  const models = [];
  let active = '';
  const blocks = toml.split(/^\[\[/m);
  for (const b of blocks) {
    if (b.startsWith('models]]')) {
      const name = (b.match(/^name\s*=\s*"([^"]+)"/m) || [])[1] || null;
      const alias = (b.match(/^alias\s*=\s*"([^"]+)"/m) || [])[1] || null;
      const thinking = (b.match(/^thinking\s*=\s*"([^"]+)"/m) || [])[1] || null;
      if (name) models.push({ name, alias: alias || name, thinking });
    }
  }
  const am = toml.match(/^active_model\s*=\s*"([^"]+)"/m);
  if (am) active = am[1];
  // Pas de [[models]] explicite dans config.toml → repli sur le catalogue Vibe
  // (model_catalog_cache.json : alias officiels, ex. mistral-large-4, mistral-medium-3.5).
  if (!models.length) {
    try {
      const home = process.env.VIBE_HOME || path.join(os.homedir(), '.vibe');
      const cache = JSON.parse(fs.readFileSync(path.join(home, 'model_catalog_cache.json'), 'utf8'));
      const entry = Object.values(cache)[0];
      for (const m of (entry && entry.payload && entry.payload.models) || []) {
        const levels = (m.parameters && m.parameters.reasoning) || null;
        for (const a of (m.aliases || [])) models.push({ name: m.id, alias: a, label: m.label, thinking: Array.isArray(levels) ? levels.map(String) : null });
      }
    } catch (_) {}
    if (!models.length) models.push({ name: 'mistral-large-4', alias: 'mistral-large-4' }, { name: 'mistral-medium-3.5', alias: 'mistral-medium-3.5' });
  }
  // thinking levels du modèle actif (catalogue), sinon liste par défaut
  const activeM = models.find((m) => (m.alias || m.name) === (active || (models[0] && (models[0].alias || models[0].name))));
  const thinkingLevels = (activeM && activeM.thinking && activeM.thinking.length ? activeM.thinking : ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  return {
    models,
    activeModel: active || (models[0] && (models[0].alias || models[0].name)) || '',
    thinkingLevels,
    modes: [
      { id: 'default', label: 'Ask', agent: 'ask' },
      { id: 'acceptEdits', label: 'Accept edits', agent: 'accept-edits' },
      { id: 'auto', label: 'Auto-approve', agent: 'auto-approve' },
    ],
  };
}

// Noms préfixés vibe* : agent.js exporte déjà setMode/prompt/cancel… et le barrel index.js
// (`export *`) ferait disparaître les doublons en silence.
export {
  start as vibeStart, prompt as vibePrompt, cancel as vibeCancel,
  setMode as vibeSetMode, setConfig as vibeSetConfig, kill as vibeKill, vibeFork,
  vibeModeFor, vibeOptions, elicitationContent, questionsFromSchema, AcpClient as VibeAcpClient,
};
