/*
 * Driver pi (provider "pi") — pilotage des sessions via le mode RPC de pi (JSONL sur stdio),
 * cf. docs/port-pi.md. Remplace l'ancien driver ACP (vibe-acp) de la branche feat/vibe-provider.
 *
 * Chaque session pilotée = un process `pi --mode rpc` spawned, avec lequel on parle JSONL :
 *   client → pi : {"id","type":"prompt"|"abort"|"get_state"|"set_model"|"set_thinking_level"|…}
 *   pi → client : {"id","type":"response","command",success,data} + événements de session
 *                 (message_update avec assistantMessageEvent text_delta/toolcall_*,
 *                  tool_execution_start/end, agent_settled…)
 *
 * Le registre d'état (st) est le MÊME que celui d'agent.js : agent.js dispatche vers ce module
 * quand st.provider === 'pi'. Pi n'a pas de mécanisme d'approbation côté protocole (les outils
 * s'exécutent directement en RPC) → les sessions pi sont toujours auto-approve, pas de pendingAsk.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { scanPiSessions } from './pi.js';

const err400 = (msg) => Object.assign(new Error(msg), { code: 400 });

// Résolution du binaire pi : HOOKED_PI_BIN, puis `which pi`, puis les installs mise/npm globales
// (sous launchd le PATH est figé — loginEnv le répare pour les drivers, mais un fallback explicite
// rend le headless robuste partout).
import { spawnSync } from 'node:child_process';
import os from 'node:os';
function resolvePiBin() {
  if (process.env.HOOKED_PI_BIN) return process.env.HOOKED_PI_BIN;
  try {
    const r = spawnSync('which', ['pi'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch (_) {}
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'share', 'mise', 'installs', 'node', '24', 'bin', 'pi'),
    path.join(home, '.npm-global', 'bin', 'pi'),
    '/usr/local/bin/pi', '/opt/homebrew/bin/pi',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return 'pi';
}
const piBin = () => resolvePiBin();
const RPC_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// Client RPC pi (stdio, JSONL strict : split sur LF uniquement)
// ---------------------------------------------------------------------------
class PiRpcClient {
  constructor(args, { cwd, env }) {
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.onEvent = null;      // (record) — événements de session (pas les réponses)
    this.proc = spawn(piBin(), args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    this.proc.stderr.on('data', () => {}); // logs pi : on les avale (jamais bloquant)
    this.proc.on('error', (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
      if (this.onExit) this.onExit(-1, String(e && e.message || e));
    });
    this.proc.on('exit', (code, signal) => {
      for (const p of this.pending.values()) p.reject(new Error(`pi exited (${code ?? signal})`));
      this.pending.clear();
      if (this.onExit) this.onExit(code, signal);
    });
  }

  _handleLine(line) {
    let rec;
    try { rec = JSON.parse(line); } catch (_) { return; }
    if (rec && rec.type === 'response') {
      const p = rec.id != null ? this.pending.get(rec.id) : null;
      if (p) {
        this.pending.delete(rec.id);
        clearTimeout(p.timer);
        if (rec.success) p.resolve(rec);
        else p.reject(new Error(rec.error || `pi ${rec.command} failed`));
      }
      return;
    }
    if (this.onEvent) { try { this.onEvent(rec); } catch (_) {} }
  }

  call(type, params = {}, timeoutMs = RPC_TIMEOUT) {
    const id = 'r' + this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi ${type} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify({ id, type, ...params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close() {
    try { this.proc.stdin.end(); } catch (_) {}
    setTimeout(() => { try { this.proc.kill('SIGTERM'); } catch (_) {} }, 3000).unref?.();
  }
}

// ---------------------------------------------------------------------------
// Événements pi → registre st (mêmes champs que le driver ACP : stream/activity/lastProse/usage)
// ---------------------------------------------------------------------------
function handleEvent(st, rec) {
  if (!rec || !rec.type) return;
  st.lastMsgAt = Date.now();
  st.sawMsg = true;
  let dirty = false;
  switch (rec.type) {
    case 'message_update': {
      const ev = rec.assistantMessageEvent || {};
      st.stream = st.stream || { text: '', thinking: '', tool: null, types: {} };
      if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
        st.stream.text += ev.delta;
        st.lastProse = st.stream.text.slice(-4000);
        dirty = true;
      } else if (ev.type === 'thinking_delta' && typeof ev.delta === 'string') {
        st.stream.thinking += ev.delta;
        dirty = true;
      } else if (ev.type === 'toolcall_start') {
        st._toolNames = st._toolNames || {};
        st._toolNames[ev.id] = ev.toolName;
        st.activity = ev.toolName;
        st.stream.tool = { id: ev.id, name: ev.toolName, status: 'running', input: null };
        st.busy = true;
        if (!st.pendingAsk) st.sdkState = 'running';
        dirty = true;
      } else if (ev.type === 'toolcall_end' && ev.toolCall) {
        if (st.stream?.tool?.id === ev.toolCall.id) st.stream.tool.input = ev.toolCall.arguments;
        dirty = true;
      }
      break;
    }
    case 'tool_execution_start': {
      st.busy = true;
      if (!st.pendingAsk) st.sdkState = 'running';
      const label = rec.toolName === 'bash' ? (rec.args?.command || 'bash') : rec.toolName;
      st.activity = `${rec.toolName}: ${label}`.slice(0, 120);
      st.stream = st.stream || { text: '', thinking: '', tool: null, types: {} };
      st.stream.tool = { id: rec.toolCallId, name: rec.toolName, status: 'running', input: rec.args };
      dirty = true;
      break;
    }
    case 'tool_execution_end': {
      if (st.stream?.tool?.id === rec.toolCallId) {
        st.stream.tool.status = rec.isError ? 'error' : 'done';
        st.stream.tool.result = textOfToolResult(rec.result);
      }
      st.activity = null;
      dirty = true;
      break;
    }
    case 'message_end': {
      const m = rec.message;
      if (m && m.role === 'assistant') {
        const text = Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
        if (text) st.lastProse = text.slice(-4000);
        if (m.usage && (m.usage.totalTokens || m.usage.input)) {
          st.lastUsage = {
            ts: new Date().toISOString(),
            contextTokens: (m.usage.input || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0),
            ttl: null,
          };
        }
        st.model = m.model || st.model;
        dirty = true;
      }
      break;
    }
    case 'agent_settled': {
      // fin de tout le travail automatique : on vide le tampon de preview (le .jsonl porte le tour)
      st.stream = null;
      st.lastProse = null;
      st.busy = false;
      st.activity = null;
      if (!st.pendingAsk) st.sdkState = 'idle';
      dirty = true;
      break;
    }
    case 'turn_start': {
      st.stream = { text: '', thinking: '', tool: null, types: {} }; // nouveau tour : reset preview
      st.busy = true;
      if (!st.pendingAsk) st.sdkState = 'running';
      dirty = true;
      break;
    }
    case 'session_info_changed': {
      dirty = true;
      break;
    }
    default:
      break;
  }
  if (dirty && st._emit) st._emit();
}

function textOfToolResult(result) {
  if (!result) return null;
  const c = result.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  return typeof result === 'string' ? result : null;
}

// ---------------------------------------------------------------------------
// API driver (miroir de l'ancien vibeAgent : agent.js appelle piStart/piPrompt/…)
// ---------------------------------------------------------------------------

// pi n'a pas de « modes » de permission : en RPC les outils s'exécutent directement (auto-approve).
function piModeFor() { return null; }

function piArgsFor(st, { resumeId, model, effort, name }) {
  const args = ['--mode', 'rpc'];
  if (resumeId) {
    const src = scanPiSessions().find((s) => s.id === resumeId);
    if (src && src.file) args.push('--session', src.file);
    else args.push('--session-id', resumeId);
  } else {
    const id = crypto.randomUUID();
    st.piNewId = id;
    args.push('--session-id', id);
  }
  if (model) args.push('--model', model.startsWith('mistral/') ? model : `mistral/${model}`);
  if (effort) args.push('--thinking', effort);
  if (name) args.push('--name', name);
  return args;
}

async function piStart(st, opts, ctx) {
  const env = opts.env || process.env;
  const args = piArgsFor(st, opts);
  const client = new PiRpcClient(args, { cwd: st.cwd, env });
  st.pi = client;
  st.provider = 'pi';
  st._emit = (now) => ctx.emit && ctx.emit(st, now);
  client.onEvent = (rec) => handleEvent(st, rec);
  client.onExit = () => {
    st.stream = null;
    st.ended = true;
    st.busy = false;
    if (st.pendingAsk) { const r = st.pendingAsk.resolve; st.pendingAsk = null; try { r({ behavior: 'deny', message: 'pi exited' }); } catch (_) {} }
    if (st._emit) st._emit();
  };
  try {
    // Attendre que le process soit prêt : get_state répond dès le démarrage.
    const st0 = await client.call('get_state', {}, 30_000);
    const sessionId = st0.data?.sessionId || st.piNewId;
    if (!sessionId) throw new Error('pi returned no session id');
    st.id = sessionId;
    st.piFile = st0.data?.sessionFile || null;
    st.sawMsg = true;
    // pi en RPC exécute les outils sans demander → auto-approve côté UI.
    st.autoApprove = true;
    st.permissionMode = 'bypassPermissions';
    ctx.setLive(sessionId, st);
    ctx.persistLaunch(sessionId, opts.model || null, opts.effort || null);
    if (opts.prompt && String(opts.prompt).trim()) {
      piPrompt(st, String(opts.prompt).trim()).catch(() => {}); // le tour tourne en fond
    }
    ctx.done(st);
  } catch (e) {
    st.error = 'pi start failed: ' + ((e && e.message) || e);
    client.close();
    ctx.failStartup(st);
  }
}

function piPrompt(st, text) {
  const client = st.pi;
  if (!client) return Promise.reject(err400('pi session not started'));
  st.busy = true;
  st.sdkState = 'running';
  st.activity = null;
  return client.call('prompt', { message: text }, 3_600_000).then((res) => {
    st.busy = false;
    if (!st.pendingAsk) st.sdkState = 'idle';
    return res;
  }).catch((e) => {
    st.busy = false;
    if (!st.pendingAsk) st.sdkState = 'idle';
    throw e;
  });
}

function piCancel(st) {
  if (st.pi) return st.pi.call('abort', {}, 15_000).catch(() => {});
  return Promise.resolve();
}

function piSetMode(st, target) {
  // pas de mode de permission côté pi : on note juste le choix pour l'UI.
  st.permissionMode = target || st.permissionMode;
  return Promise.resolve();
}

function piSetConfig(st, { model, thinking }) {
  const calls = [];
  if (model) calls.push(st.pi.call('set_model', { provider: 'mistral', modelId: model.replace(/^mistral\//, '') }, 15_000));
  if (thinking) calls.push(st.pi.call('set_thinking_level', { level: thinking }, 15_000));
  return Promise.all(calls).then(() => {
    if (model) { st.model = model; st.launchModel = model; }
    if (thinking) { st.effort = thinking; st.launchEffort = thinking; }
  });
}

function piKill(st) {
  if (st.pi) {
    try { st.pi.call('abort', {}, 3_000).catch(() => {}); } catch (_) {}
    st.pi.close();
  }
  st.ended = true;
}

// Fork d'une session pi dans un process jetable : --session <src> → fork(entryId) ou clone() →
// get_state (nouveau fichier) → fermeture. Le fichier forké est créé par pi lui-même.
async function piFork(id, opts, ctx) {
  const src = scanPiSessions().find((s) => s.id === id);
  if (!src || !src.file) throw err400('pi session file not found for ' + id);
  const client = new PiRpcClient(['--mode', 'rpc', '--session', src.file], { cwd: opts.cwd || src.project || process.cwd(), env: process.env });
  const cleanup = () => client.close();
  try {
    await client.call('get_state', {}, 30_000);
    let r;
    if (opts.forkUuid) r = await client.call('fork', { entryId: opts.forkUuid }, 60_000);
    else r = await client.call('clone', {}, 60_000);
    if (!r.success || (r.data && r.data.cancelled)) throw new Error('pi fork cancelled');
    const st0 = await client.call('get_state', {}, 15_000);
    const newId = st0.data?.sessionId;
    const newFile = st0.data?.sessionFile;
    if (!newId) throw new Error('pi fork returned no session id');
    cleanup();
    return { sessionId: newId, file: newFile, cwd: opts.cwd || src.project, forkedFrom: id };
  } catch (e) {
    cleanup();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Options pi pour l'UI (modèles Mistral du catalogue pi + thinking levels)
// ---------------------------------------------------------------------------
let piOptionsCache = null;
let piOptionsAt = 0;

async function piOptions() {
  if (piOptionsCache && Date.now() - piOptionsAt < 60_000) return piOptionsCache;
  const models = [];
  try {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(piBin(), ['--list-models', 'mistral'], { encoding: 'utf8', timeout: 20_000 });
    const out = (r.stdout || '') + (r.stderr || '');
    for (const line of out.split('\n')) {
      const cols = line.trim().split(/\s{2,}|\t/);
      if (cols.length >= 2 && cols[0] === 'mistral') {
        const id = cols[1].trim();
        if (/^[a-z0-9][a-z0-9.-]*$/i.test(id)) {
          models.push({ name: id, alias: id, label: id, thinking: /\byes\b/i.test(cols[4] || '') });
        }
      }
    }
  } catch (_) {}
  if (!models.length) models.push({ name: 'mistral-large-latest', alias: 'mistral-large-latest', label: 'mistral-large-latest', thinking: true });
  piOptionsCache = {
    models,
    activeModel: models[0]?.name || null,
    thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    modes: [{ id: 'auto', label: 'Auto — pi exécute les outils directement (pas d’approbation en RPC)' }],
  };
  piOptionsAt = Date.now();
  return piOptionsCache;
}

// Stubs de compatibilité (agent.js les appelle encore dans answerQuestion*) : pi n'a pas
// d'elicitation côté protocole → jamais de pendingAsk question côté pi.
function elicitationContent() { return {}; }
function questionsFromSchema(schema) { return Array.isArray(schema?.questions) ? schema.questions : []; }

// Noms préfixés pi* : agent.js exporte déjà setMode/prompt/cancel… et le barrel index.js
// (`export *`) ferait disparaître les doublons en silence.
export {
  resolvePiBin,
  piStart, piPrompt, piCancel, piSetMode, piSetConfig, piKill, piFork, piModeFor, piOptions,
  elicitationContent, questionsFromSchema, PiRpcClient,
};
