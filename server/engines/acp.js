/*
 * Engine `acp`: any agent speaking the Agent Client Protocol (https://agentclientprotocol.com) over
 * stdio — JSON-RPC 2.0, one message per line. This is how a provider is added without code:
 *
 *   "providers": { "gemini": { "engine": "acp", "command": "gemini", "args": ["--experimental-acp"] } }
 *
 * Protocol used:
 *   client → agent : initialize, session/new, session/load, session/prompt, session/cancel (notif.),
 *                    session/set_mode, session/set_model, session/set_config_option
 *   agent → client : session/update notifications (message/thought chunks, tool_call(_update), plan,
 *                    available_commands_update, current_mode_update, config_option_update,
 *                    session_info_update, usage_update) and requests: session/request_permission
 *                    (→ the dashboard's permission card), elicitation/create (→ a question).
 * The client advertises no fs / terminal capability: agents use their own tools.
 *
 * ACP agents keep their history in their own format, so hooked journals what it sees on the wire
 * (server/engines/journal.js) and serves the session list, conversation, Trace lens, todos (ACP
 * `plan`), search and trash from that journal. hooked's own MCP server is injected into every
 * session (`injectHookedMcp: false` to opt out), so `start_session`, `show_panel`… work from these
 * agents too.
 *
 * Derived from the former vibe-acp driver (git history, server/vibeAgent.js).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { providerEnv, modelMatches } from '../providerConfig.js';
import {
  openJournal, journalFile, journalRoot, scanJournal, journalConversation, journalTrace, journalToolDetail,
  journalMessageText, journalTodos, journalContext, journalToolPaths, journalSetArchived,
} from './journal.js';

const err400 = (msg) => Object.assign(new Error(msg), { code: 400 });
const ACP_DEFER = Symbol('acp-defer');
const RPC_TIMEOUT = 120_000;

const expandHome = (p) => (typeof p === 'string' && (p === '~' || p.startsWith('~/')) ? path.join(os.homedir(), p.slice(1)) : p);

function commandOf(provider) {
  return provider && provider.command ? expandHome(provider.command) : null;
}

function commandAvailable(cmd) {
  if (!cmd) return false;
  try {
    if (cmd.includes('/')) { fs.accessSync(cmd, fs.constants.X_OK); return true; }
    return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
  } catch (_) { return false; }
}

// ── Minimal ACP client (stdio, newline-delimited JSON-RPC 2.0) ─────────────────────────────────
class AcpClient {
  constructor(cmd, args, { cwd, env }) {
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = null; // (method, params)
    this.onRequest = null;      // (id, method, params) -> result | { __error } | ACP_DEFER
    this.onExit = null;
    this.stderr = '';
    this.proc = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim()) this._handleLine(line);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4096); });
    this.proc.stdin.on('error', () => {}); // EPIPE after the agent died: reported through 'exit'
    const fail = (why) => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
      this.pending.clear();
      if (this.onExit) { const f = this.onExit; this.onExit = null; f(why); }
    };
    this.proc.on('error', (e) => fail(`agent failed to start: ${(e && e.message) || e}`));
    this.proc.on('exit', (code, signal) => fail(`agent exited (${code ?? signal})`));
  }

  _handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) { return; }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'ACP error'), { acpCode: msg.error.code, data: msg.error.data }));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.id !== undefined && msg.method) {
      let result;
      try { result = this.onRequest ? this.onRequest(msg.id, msg.method, msg.params || {}) : { __error: { code: -32601, message: 'method not found' } }; }
      catch (e) { result = { __error: { code: -32603, message: String((e && e.message) || e) } }; }
      if (result === ACP_DEFER) return;
      if (result && result.__error) this.send({ jsonrpc: '2.0', id: msg.id, error: result.__error });
      else this.send({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result });
      return;
    }
    if (msg.method && this.onNotification) {
      try { this.onNotification(msg.method, msg.params || {}); } catch (_) { /* a bad update must not kill the session */ }
    }
  }

  send(obj) {
    try { this.proc.stdin.write(JSON.stringify(obj) + '\n'); } catch (_) { /* agent gone */ }
  }

  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }

  call(method, params, timeoutMs = RPC_TIMEOUT) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  close() {
    try { this.proc.stdin.end(); } catch (_) {}
    const t = setTimeout(() => { try { this.proc.kill('SIGTERM'); } catch (_) {} }, 2000);
    t.unref?.();
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────
const textOfBlock = (c) => (c && typeof c.text === 'string' ? c.text : '');

// ACP tool-call content → { output, diffs }.
function toolContent(content) {
  let output = '';
  const diffs = [];
  for (const c of Array.isArray(content) ? content : []) {
    if (!c) continue;
    if (c.type === 'content' && c.content) output += (output ? '\n' : '') + textOfBlock(c.content);
    else if (c.type === 'diff' && c.path) diffs.push({ path: c.path, oldText: c.oldText ?? null, newText: c.newText ?? '' });
  }
  return { output: output || null, diffs };
}

function rawOutputText(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return raw;
  try { return JSON.stringify(raw, null, 2).slice(0, 8000); } catch (_) { return null; }
}

// hooked permission mode → the agent's mode id. Explicit `modes` mapping first, then a guess by
// id/name among the modes the agent advertised.
const MODE_GUESS = {
  default: /^(default|ask|normal|manual|read[-_ ]?only)$/i,
  acceptEdits: /accept.?edits|auto.?edit/i,
  plan: /plan/i,
  auto: /^(auto|bypass|yolo|full.?access|agent)/i,
  bypassPermissions: /bypass|yolo|full.?access|auto/i,
  dontAsk: /bypass|yolo|full.?access|auto/i,
};
function agentModeFor(target, provider, available) {
  if (provider && provider.modes && provider.modes[target]) return provider.modes[target];
  const list = Array.isArray(available) ? available : [];
  const re = MODE_GUESS[target];
  if (!re) return null;
  const hit = list.find((m) => re.test(m.id || '') || re.test(m.name || ''));
  return hit ? hit.id : null;
}

// Session config options (newer ACP): the one of a category ('model', 'mode', 'thought_level').
function configOption(st, category, idRe) {
  const opts = Array.isArray(st.acpConfigOptions) ? st.acpConfigOptions : [];
  return opts.find((o) => o && (o.category === category || (idRe && idRe.test(String(o.id || ''))))) || null;
}

// What a session/new (or load) response says about models, modes and config options.
function absorbSessionSetup(st, r) {
  if (!r || typeof r !== 'object') return;
  if (r.modes && Array.isArray(r.modes.availableModes)) {
    st.acpModes = r.modes.availableModes.map((m) => ({ id: m.id, name: m.name || m.id, description: m.description || '' }));
    st.acpModeId = r.modes.currentModeId || null;
  }
  if (r.models && Array.isArray(r.models.availableModels)) {
    st.acpModels = r.models.availableModels.map((m) => ({ id: m.modelId || m.id, name: m.name || m.modelId || m.id }));
    st.model = r.models.currentModelId || st.model;
  }
  if (Array.isArray(r.configOptions)) st.acpConfigOptions = r.configOptions;
  const mo = configOption(st, 'model', /^model$/i);
  if (mo && mo.currentValue) st.model = String(mo.currentValue);
}

// Per-provider launch options learnt from the last live session (models, modes, efforts): an ACP
// agent cannot be asked for them without opening a session, so the « New session » pickers use
// the last answer, kept on disk next to the provider's journals.
function optionsFile(providerId) {
  return path.join(journalRoot(), providerId, '.options.json');
}
function rememberOptions(st) {
  const providerId = st.provider;
  if (!providerId) return;
  const effortOpt = configOption(st, 'thought_level', /thought|thinking|effort|reasoning/i);
  const modelOpt = configOption(st, 'model', /^model$/i);
  const models = modelOpt && Array.isArray(modelOpt.options)
    ? modelOpt.options.map((o) => ({ id: String(o.value), name: o.name || String(o.value) }))
    : (st.acpModels || []);
  const out = {
    at: new Date().toISOString(),
    models,
    efforts: effortOpt && Array.isArray(effortOpt.options) ? effortOpt.options.map((o) => String(o.value)) : [],
    modes: st.acpModes || [],
  };
  try {
    fs.mkdirSync(path.dirname(optionsFile(providerId)), { recursive: true });
    fs.writeFileSync(optionsFile(providerId), JSON.stringify(out));
  } catch (_) { /* best effort */ }
}

// ACP stdio MCP server entry from hooked's { command, args, env } shape.
function acpMcpServer(name, srv) {
  if (!srv || !srv.command) return null;
  return {
    name,
    command: srv.command,
    args: Array.isArray(srv.args) ? srv.args : [],
    env: Object.entries(srv.env || {}).map(([k, v]) => ({ name: k, value: String(v) })),
  };
}

// ── Incoming requests (permissions, questions) ──────────────────────────────────────────────────
function pickOption(options, kinds) {
  for (const k of kinds) {
    const o = (options || []).find((x) => x.kind === k);
    if (o) return o.optionId;
  }
  return null;
}

function questionsFromSchema(schema) {
  const props = (schema && schema.properties) || {};
  return Object.keys(props).map((key) => {
    const p = props[key] || {};
    const oneOf = p.oneOf || (p.items && (p.items.anyOf || p.items.oneOf)) || (Array.isArray(p.enum) ? p.enum.map((v) => ({ const: v })) : []);
    return {
      key,
      question: p.description || p.title || key,
      header: p.title || '',
      multiSelect: p.type === 'array',
      options: oneOf.map((o) => ({ label: String(o.title || o.const || o) })),
    };
  });
}

function handleAgentRequest(st, client, reqId, method, params) {
  if (method === 'session/request_permission') {
    const tc = params.toolCall || {};
    const tcId = tc.toolCallId || null;
    const toolName = tc.title || (st._toolNames && st._toolNames[tcId]) || tc.kind || 'tool';
    const options = (params.options || []).map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }));
    const ask = { kind: 'permission', id: 'acp:' + reqId, toolName, input: tc.rawInput || null, options, resolve: null };
    const answer = (resp) => {
      const deny = !resp || resp.behavior === 'deny';
      const optionId = deny
        ? pickOption(options, ['reject_once', 'reject_always'])
        : pickOption(options, resp.allowAlways ? ['allow_always', 'allow_once'] : ['allow_once', 'allow_always']);
      client.send({
        jsonrpc: '2.0', id: reqId,
        result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } },
      });
    };
    ask.resolve = (resp) => {
      if (st.pendingAsk === ask) { st.pendingAsk = null; st.sdkState = 'running'; st.busy = true; }
      answer(resp);
      if (st._emit) st._emit();
    };
    if (st.autoApprove) { answer({ behavior: 'allow' }); return ACP_DEFER; }
    st.pendingAsk = ask;
    st.sdkState = 'requires_action';
    st.busy = false;
    if (st._emit) st._emit(true);
    return ACP_DEFER;
  }
  if (method === 'elicitation/create' || method === 'session/elicitation') {
    const schema = (params.mode && (params.mode.requestedSchema || params.mode.requested_schema)) || params.requestedSchema || {};
    const questions = questionsFromSchema(schema);
    const ask = { kind: 'question', id: 'acp:' + reqId, questions, resolve: null };
    const answer = (resp) => {
      let result = { action: 'decline' };
      if (resp && Array.isArray(resp.selections)) {
        const content = {};
        questions.forEach((q, i) => {
          const sel = resp.selections[i] || {};
          const labels = (Array.isArray(sel.indices) ? sel.indices : []).map((n) => q.options[n] && q.options[n].label).filter(Boolean);
          const other = typeof sel.other === 'string' ? sel.other.trim() : '';
          content[q.key] = q.multiSelect ? [...labels, ...(other ? [other] : [])] : (other || labels[0] || '');
        });
        result = { action: 'accept', content };
      } else if (resp && resp.freeTextAnswer) {
        const content = {};
        questions.forEach((q, i) => { content[q.key] = i === 0 ? resp.freeTextAnswer : ''; });
        result = { action: 'accept', content };
      }
      client.send({ jsonrpc: '2.0', id: reqId, result });
    };
    ask.resolve = (resp) => {
      if (st.pendingAsk === ask) { st.pendingAsk = null; st.sdkState = 'running'; st.busy = true; }
      answer(resp);
      if (st._emit) st._emit();
    };
    st.pendingAsk = ask;
    st.sdkState = 'requires_action';
    st.busy = false;
    if (st._emit) st._emit(true);
    return ACP_DEFER;
  }
  // fs/* and terminal/* are not advertised; anything else is unknown.
  return { __error: { code: -32601, message: `method not supported by hooked: ${method}` } };
}

// ── session/update → live registry state + journal ──────────────────────────────────────────────
function handleUpdate(st, method, params) {
  if (method !== 'session/update') return;
  const u = params.update || {};
  const kind = u.sessionUpdate;
  const j = st.acpJournal;
  st.lastMsgAt = Date.now();
  st.sawMsg = true;
  let dirty = false;
  switch (kind) {
    case 'agent_message_chunk': {
      const text = textOfBlock(u.content);
      if (!text) break;
      st.stream = st.stream || { text: '', thinking: '', tool: null };
      st.stream.text += text;
      st.lastProse = st.stream.text.slice(-4000);
      if (j) j.text(text);
      dirty = true;
      break;
    }
    case 'agent_thought_chunk': {
      const text = textOfBlock(u.content);
      if (!text) break;
      st.stream = st.stream || { text: '', thinking: '', tool: null };
      st.stream.thinking += text;
      if (j) j.thinking(text);
      dirty = true;
      break;
    }
    case 'user_message_chunk':
      // Echo of our own prompt (or replay during session/load): recorded by prompt() already.
      break;
    case 'tool_call': {
      st.busy = true;
      if (!st.pendingAsk) st.sdkState = 'running';
      const id = u.toolCallId;
      const raw = u.rawInput && typeof u.rawInput === 'object' ? u.rawInput : {};
      const title = u.title || raw.command || raw.path || raw.file_path || u.kind || 'tool';
      st.activity = String(title).slice(0, 120);
      if (id) { st._toolNames = st._toolNames || {}; st._toolNames[id] = title; }
      st.stream = st.stream || { text: '', thinking: '', tool: null };
      st.stream.tool = String(title).slice(0, 80);
      const { output, diffs } = toolContent(u.content);
      if (j) j.tool({ id, name: u.kind || 'tool', title, kind: u.kind || null, input: raw, status: u.status || 'pending', ...(output ? { output } : {}), ...(diffs.length ? { diffs } : {}) });
      dirty = true;
      break;
    }
    case 'tool_call_update': {
      const id = u.toolCallId;
      const { output, diffs } = toolContent(u.content);
      const out = output || rawOutputText(u.rawOutput);
      if (j) {
        j.toolUpdate({
          id,
          ...(u.status ? { status: u.status } : {}),
          ...(out != null ? { output: out } : {}),
          ...(u.status === 'failed' ? { error: true } : {}),
          ...(u.rawInput && typeof u.rawInput === 'object' ? { input: u.rawInput } : {}),
          ...(u.title ? { title: u.title } : {}),
          ...(diffs.length ? { diffs } : {}),
        });
      }
      if (u.status === 'completed' || u.status === 'failed') { st.activity = null; if (st.stream) st.stream.tool = null; }
      dirty = true;
      break;
    }
    case 'plan': {
      const todos = (Array.isArray(u.entries) ? u.entries : []).map((e) => ({ content: String(e.content || ''), status: e.status || 'pending', priority: e.priority || null }));
      st.todos = todos;
      if (j) j.todos(todos);
      dirty = true;
      break;
    }
    case 'available_commands_update': {
      const cmds = Array.isArray(u.availableCommands) ? u.availableCommands : [];
      st.liveCommands = cmds.map((c) => ({ name: c.name, description: c.description || '', argumentHint: (c.input && c.input.hint) || '' }));
      lastCommands.set(st.provider, st.liveCommands);
      break;
    }
    case 'current_mode_update':
      st.acpModeId = u.currentModeId || st.acpModeId;
      dirty = true;
      break;
    case 'config_option_update':
    case 'config_options_update':
      if (Array.isArray(u.configOptions)) { st.acpConfigOptions = u.configOptions; absorbSessionSetup(st, { configOptions: u.configOptions }); }
      dirty = true;
      break;
    case 'session_info_update':
      if (u.title && j) j.meta({ title: String(u.title).slice(0, 200) });
      dirty = true;
      break;
    case 'usage_update': {
      // Unstable in ACP: context `used` / `size`, optional cost.
      const used = Number(u.used) || null;
      const size = Number(u.size) || null;
      if (used) st.lastUsage = { ts: new Date().toISOString(), contextTokens: used, ttl: null };
      if (j && (used || u.cost)) j.usage({ contextTokens: used, contextWindow: size, ...(u.cost && typeof u.cost.amount === 'number' ? { cost: u.cost.amount } : {}) });
      dirty = true;
      break;
    }
    default:
      break;
  }
  if (dirty && st._emit) st._emit();
}

// The last « / » list an agent declared, per provider (the New session composer has no session).
const lastCommands = new Map();

// ── Driver ──────────────────────────────────────────────────────────────────────────────────────
function promptBlocks(text) {
  return [{ type: 'text', text }];
}

function prompt(st, text) {
  const client = st.acp;
  if (!client || !st.acpSessionId) return Promise.reject(err400('session not started'));
  if (st.acpTurn) {
    // ACP has no steering: a message sent mid-turn waits for the turn to end.
    st.acpQueue = st.acpQueue || [];
    st.acpQueue.push(text);
    return Promise.resolve({ queued: true });
  }
  st.acpTurn = true;
  st.busy = true;
  st.sdkState = 'running';
  st.activity = null;
  st.stream = { text: '', thinking: '', tool: null };
  st.lastRequestAt = Date.now();
  if (st.acpJournal) st.acpJournal.user(text);
  if (st._emit) st._emit();
  return client.call('session/prompt', { sessionId: st.acpSessionId, prompt: promptBlocks(text) }, 0).then((res) => {
    endTurn(st, res && res.stopReason, res && res.usage);
    return res;
  }).catch((e) => {
    if (st.acpJournal) st.acpJournal.error((e && e.message) || String(e));
    endTurn(st, 'error');
    throw e;
  });
}

function endTurn(st, stopReason, usage = null) {
  st.acpTurn = false;
  if (st.acpJournal) {
    if (usage && typeof usage === 'object') {
      st.acpJournal.usage({
        input: usage.inputTokens || usage.input_tokens || 0,
        output: usage.outputTokens || usage.output_tokens || 0,
        cacheRead: usage.cachedReadTokens || usage.cacheReadTokens || 0,
        cacheWrite: usage.cachedWriteTokens || usage.cacheWriteTokens || 0,
        contextTokens: usage.totalTokens || null,
      });
    }
    st.acpJournal.turnEnd(stopReason || null);
  }
  st.stream = null;
  st.lastProse = null;
  st.activity = null;
  st.busy = false;
  if (!st.pendingAsk) st.sdkState = 'idle';
  if (st._emit) st._emit(true);
  if (typeof st.onTurnEnd === 'function') { try { st.onTurnEnd(); } catch (_) {} }
  const next = st.acpQueue && st.acpQueue.shift();
  if (next && !st.ended) prompt(st, next).catch(() => {});
}

async function start(st, opts, ctx) {
  const provider = st.providerConfig || {};
  const cmd = commandOf(provider);
  if (!cmd) { st.error = 'ACP provider has no `command`'; return ctx.failStartup(st); }
  const env = providerEnv(opts.env || process.env, provider);
  const client = new AcpClient(cmd, Array.isArray(provider.args) ? provider.args : [], { cwd: st.cwd, env });
  st.acp = client;
  st._emit = (now) => ctx.emit && ctx.emit(st, now);
  client.onNotification = (m, p) => handleUpdate(st, m, p);
  client.onRequest = (id, m, p) => handleAgentRequest(st, client, id, m, p);
  client.onExit = (why) => {
    st.stream = null;
    st.ended = true;
    st.busy = false;
    st.acpTurn = false;
    if (st.acpJournal) st.acpJournal.flush();
    if (st.pendingAsk) { const r = st.pendingAsk.resolve; st.pendingAsk = null; try { r({ behavior: 'deny' }); } catch (_) {} }
    if (!st.sawMsg) st.error = st.error || why;
    if (st._emit) st._emit(true);
  };
  try {
    const init = await client.call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'hooked', version: '1' },
    }, 30_000);
    st.acpAgent = (init && (init.agentInfo || init.agent_info)) || null;
    const caps = (init && init.agentCapabilities) || {};
    const mcpServers = [];
    if (provider.injectHookedMcp !== false && ctx.hookedMcp) {
      const m = acpMcpServer('hooked', ctx.hookedMcp());
      if (m) mcpServers.push(m);
    }
    let sessionId;
    let setup = null;
    if (opts.resumeId) {
      if (!caps.loadSession) throw new Error(`${provider.label || st.provider} cannot resume a session (the agent does not support session/load)`);
      sessionId = opts.resumeId;
      // The agent replays the conversation as session/update notifications: already journaled.
      st.acpJournal = openJournal(st.provider, sessionId, { engine: 'acp', cwd: st.cwd });
      if (st.acpJournal) st.acpJournal.paused = true;
      setup = await client.call('session/load', { sessionId, cwd: st.cwd, mcpServers }, 120_000);
      if (st.acpJournal) st.acpJournal.paused = false;
    } else {
      setup = await client.call('session/new', { cwd: st.cwd, mcpServers }, 60_000);
      sessionId = setup && setup.sessionId;
      if (!sessionId) throw new Error('the agent returned no session id');
      st.acpJournal = openJournal(st.provider, sessionId, {
        engine: 'acp', cwd: st.cwd, agent: st.acpAgent ? { name: st.acpAgent.name || null, version: st.acpAgent.version || null } : null,
      });
    }
    st.id = sessionId;
    st.acpSessionId = sessionId;
    st.acpCaps = caps;
    absorbSessionSetup(st, setup);
    st.sawMsg = true;
    st.stream = null;
    ctx.setLive(sessionId, st);
    // Launch configuration: model, effort, permission mode (each best effort: an agent that does
    // not expose one keeps its own default).
    const model = opts.model || (!opts.resumeId && provider.defaultModel) || null;
    const effort = opts.effort || (!opts.resumeId && provider.defaultEffort) || null;
    if (model || effort) await setConfig(st, { model, effort }).catch(() => {});
    if (opts.permissionMode) await setMode(st, opts.permissionMode).catch(() => {});
    else st.permissionMode = 'default';
    if (st.acpJournal && st.model) st.acpJournal.meta({ model: st.model });
    rememberOptions(st);
    ctx.persistLaunch(sessionId, opts.model || null, opts.effort || null);
    if (opts.prompt && String(opts.prompt).trim()) prompt(st, String(opts.prompt).trim()).catch(() => {});
    ctx.done(st);
  } catch (e) {
    const tail = client.stderr ? ` — ${client.stderr.trim().split('\n').slice(-2).join(' ')}` : '';
    const auth = e && e.acpCode === -32000 ? ' (the agent needs to be signed in: run it once in a terminal)' : '';
    st.error = `${st.provider} start failed: ${(e && e.message) || e}${auth}${tail}`;
    if (st.acpJournal) st.acpJournal.paused = false;
    client.close();
    ctx.failStartup(st);
  }
}

function cancel(st) {
  if (st.acp && st.acpSessionId) {
    st.acpQueue = [];
    st.acp.notify('session/cancel', { sessionId: st.acpSessionId });
  }
  return Promise.resolve();
}

function setMode(st, target) {
  const modeId = agentModeFor(target, st.providerConfig, st.acpModes);
  const opt = configOption(st, 'mode', /^mode$/i);
  if (!modeId && !opt) return Promise.reject(err400(`this agent has no mode matching "${target}"`));
  const call = opt && !st.acpModes
    ? st.acp.call('session/set_config_option', { sessionId: st.acpSessionId, configId: opt.id, value: modeId || target }, 15_000)
    : st.acp.call('session/set_mode', { sessionId: st.acpSessionId, modeId }, 15_000);
  return call.then(() => { st.permissionMode = target; st.acpModeId = modeId || st.acpModeId; });
}

async function setConfig(st, { model, effort }) {
  if (model) {
    const opt = configOption(st, 'model', /^model$/i);
    if (opt) {
      const r = await st.acp.call('session/set_config_option', { sessionId: st.acpSessionId, configId: opt.id, value: model }, 15_000);
      if (r && Array.isArray(r.configOptions)) st.acpConfigOptions = r.configOptions;
    } else if (st.acpModels) {
      await st.acp.call('session/set_model', { sessionId: st.acpSessionId, modelId: model }, 15_000);
    } else {
      throw err400('this agent does not let the client pick a model');
    }
    st.model = model;
    st.launchModel = model;
    if (st.acpJournal) st.acpJournal.meta({ model });
  }
  if (effort) {
    const opt = configOption(st, 'thought_level', /thought|thinking|effort|reasoning/i);
    if (!opt) throw err400('this agent exposes no effort / thinking option');
    const r = await st.acp.call('session/set_config_option', { sessionId: st.acpSessionId, configId: opt.id, value: effort }, 15_000);
    if (r && Array.isArray(r.configOptions)) st.acpConfigOptions = r.configOptions;
    st.effort = effort;
    st.launchEffort = effort;
  }
}

function kill(st) {
  if (st.acp) {
    cancel(st);
    st.acp.close();
  }
  if (st.acpJournal) st.acpJournal.flush();
  st.ended = true;
}

// ── Options for the pickers ────────────────────────────────────────────────────────────────────
function readOptionsCache(providerId) {
  try { return JSON.parse(fs.readFileSync(optionsFile(providerId), 'utf8')); } catch (_) { return null; }
}

async function options(provider) {
  const cached = readOptionsCache(provider.id) || {};
  const patterns = Array.isArray(provider.models) ? provider.models : null;
  const models = (cached.models || [])
    .filter((m) => modelMatches(patterns, m.id))
    .map((m) => ({ name: m.id, alias: m.id, label: m.name || m.id, thinking: cached.efforts && cached.efforts.length ? cached.efforts : null }));
  // A configured default the agent never listed yet still shows (first launch).
  if (provider.defaultModel && !models.some((m) => m.name === provider.defaultModel)) {
    models.unshift({ name: provider.defaultModel, alias: provider.defaultModel, label: provider.defaultModel, thinking: null });
  }
  return {
    models,
    activeModel: provider.defaultModel || null,
    defaultEffort: provider.defaultEffort || null,
    thinkingLevels: cached.efforts || [],
    // hooked's permission-mode vocabulary (what /api/launch validates), limited to the modes this
    // agent has an equivalent for — mapped by the `modes` setting or by name.
    modes: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']
      .map((id) => ({ id, agentMode: agentModeFor(id, provider, cached.modes) }))
      .filter((m) => m.agentMode)
      .map((m) => ({ id: m.id, label: `${m.id} (${m.agentMode})` })),
    learnedAt: cached.at || null,
  };
}

// ── Engine ──────────────────────────────────────────────────────────────────────────────────────
const acpEngine = {
  id: 'acp',
  label: 'ACP agent',
  builtin: true,
  capabilities: {
    permissions: true, questions: true, plan: false, modes: true, autoApprove: true,
    models: true, effort: true, resume: true, fork: false, forkAtMessage: false,
    worktree: true, ephemeral: true, images: false,
    todos: true, subagents: false, backgroundJobs: false, workflows: false, screenshots: false, subSessions: false,
    trace: true, search: true, trash: true, rateLimits: false, promptCache: false, commands: true, skills: false,
    mcp: false, mcpLogin: false, memory: false, plugins: false, remoteControl: false, account: false,
  },
  mcpKind: null,
  skillsKind: null,

  detect(provider) { return commandAvailable(commandOf(provider)); },
  available(provider) {
    const cmd = commandOf(provider);
    if (!cmd) return `provider ${provider.id} has no \`command\`: set the agent's ACP command in the hooked settings`;
    return commandAvailable(cmd) ? null : `${cmd} is not installed or not executable (provider ${provider.id})`;
  },
  validateModel(m) { return /^[A-Za-z0-9._:/@+[\] -]{1,160}$/.test(String(m || '')) ? null : 'invalid model: ' + m; },
  validateEffort(e) { return /^[A-Za-z0-9._-]{1,40}$/.test(String(e || '')) ? null : 'invalid effort: ' + e; },

  storeKey(provider) { return 'journal:' + provider.id; },
  scan(provider) { return scanJournal([provider.id]); },
  conversation(s) { return journalConversation(s.file); },
  messageText(s, id) { return journalMessageText(s.file, id); },
  trace(s) { return journalTrace(s.file); },
  toolDetail(s, id) { return journalToolDetail(s.file, id); },
  todos(s) { return journalTodos(s.file); },
  context(s) { return journalContext(s); },
  toolPaths(s) { return journalToolPaths(s.file); },
  setArchived(s, archived) { return journalSetArchived(s.file, archived); },
  resumeCommand() { return null; },
  journalFileFor(providerId, id) { return journalFile(providerId, id); },

  driver: {
    start,
    prompt: (st, text) => prompt(st, text),
    cancel,
    setMode,
    setConfig,
    kill,
    answerQuestion: (st, ask, { selections }) => ask.resolve({ behavior: 'allow', selections }),
    liveCommands: (st) => st.liveCommands || null,
  },
  options,
  slashCommands: (provider) => lastCommands.get(provider.id) || [],
};

export { acpEngine, AcpClient, agentModeFor, questionsFromSchema };
