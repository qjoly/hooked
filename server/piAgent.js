/*
 * Driver of the `pi` engine — sessions driven through pi's RPC mode (JSONL over stdio),
 * cf. docs/port-pi.md and docs/providers.md.
 *
 * Each driven session = one spawned `pi --mode rpc` process:
 *   client → pi : {"id","type":"prompt"|"abort"|"get_state"|"set_model"|"set_thinking_level"|…}
 *   pi → client : {"id","type":"response","command",success,data} + session events
 *                 (message_update with assistantMessageEvent text_delta/toolcall_*,
 *                  tool_execution_start/end, agent_settled…)
 *
 * The registry entry (st) is the SAME as agent.js's: agent.js dispatches here through the engine
 * registry (server/providers.js). Everything that used to be Mistral-specific comes from the
 * PROVIDER config now (st.providerConfig): binary, extra args, environment, agent dir, model
 * filters, default model, title model. pi has no approval mechanism in RPC (tools run directly),
 * so pi sessions are always auto-approve, with no pendingAsk.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { scanPiSessions } from './pi.js';
import { providerEnv, modelMatches } from './providerConfig.js';
import { piCatalog } from './piCatalog.js';
import { PI_SESSIONS_DIR } from './config.js';
import { hookedPiPackage, hookedPackageEnabled, hookedPackageEnv, handleUiRequest } from './piHooked.js';
import { suggestFollowup } from './piFollowup.js';

// Follow-up suggestions at the end of a turn (server/piFollowup.js); HOOKED_PI_FOLLOWUPS=0 turns them off.
const followupsOn = () => process.env.HOOKED_PI_FOLLOWUPS !== '0';

const err400 = (msg) => Object.assign(new Error(msg), { code: 400 });

// Résolution du binaire pi : HOOKED_PI_BIN, puis `which pi`, puis les installs mise/npm globales
// (sous launchd le PATH est figé — loginEnv le répare pour les drivers, mais un fallback explicite
// rend le headless robuste partout).
import { spawnSync } from 'node:child_process';
import os from 'node:os';
function resolvePiBin(provider = null) {
  if (provider && provider.command) return expandHome(provider.command);
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
const piBin = (provider = null) => resolvePiBin(provider);

function expandHome(p) {
  return typeof p === 'string' && (p === '~' || p.startsWith('~/')) ? path.join(os.homedir(), p.slice(1)) : p;
}

// Environment of a pi subprocess for a provider: the login env, the provider's `env` on top, and
// its `agentDir` as PI_CODING_AGENT_DIR (a second pi profile: own auth, models, sessions).
function piEnvFor(baseEnv, provider) {
  const env = providerEnv(baseEnv || process.env, provider);
  if (provider && provider.agentDir) env.PI_CODING_AGENT_DIR = expandHome(provider.agentDir);
  return env;
}

// Le binaire résolu est-il réellement utilisable sur cette machine ? (chemin absolu → test
// X_OK ; simple nom → `which`). Sert à refuser proprement un lancement pi quand pi n'est pas
// installé (machine sans pi, ou providers.pi forcé "on" par erreur) au lieu d'un spawn ENOENT.
function piBinaryAvailable(provider = null) {
  const bin = resolvePiBin(provider);
  try {
    if (bin.includes('/')) {
      fs.accessSync(bin, fs.constants.X_OK);
      return true;
    }
    return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
  } catch (_) {
    return false;
  }
}

const RPC_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// Client RPC pi (stdio, JSONL strict : split sur LF uniquement)
// ---------------------------------------------------------------------------
class PiRpcClient {
  constructor(args, { cwd, env, bin = null }) {
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.onEvent = null;      // (record) — événements de session (pas les réponses)
    this.stderr = '';         // last 4 KB, surfaced when the start fails
    this.proc = spawn(bin || piBin(), args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4096); }); // never blocking
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

  // A record that expects no response (extension_ui_response).
  send(obj) {
    try { this.proc.stdin.write(JSON.stringify(obj) + '\n'); } catch (_) { /* pi gone */ }
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
        // `tool` is the NAME, as on the Claude path (the UI prints it); the call itself is kept
        // beside it for whoever needs the details.
        st.stream.tool = ev.toolName || null;
        st.stream.toolCall = { id: ev.id, name: ev.toolName, status: 'running', input: null };
        st.busy = true;
        if (!st.pendingAsk) st.sdkState = 'running';
        dirty = true;
      } else if (ev.type === 'toolcall_end' && ev.toolCall) {
        if (st.stream?.toolCall?.id === ev.toolCall.id) st.stream.toolCall.input = ev.toolCall.arguments;
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
      st.stream.tool = rec.toolName || null;
      st.stream.toolCall = { id: rec.toolCallId, name: rec.toolName, status: 'running', input: rec.args };
      dirty = true;
      break;
    }
    case 'tool_execution_end': {
      if (st.stream?.toolCall?.id === rec.toolCallId) {
        st.stream.toolCall.status = rec.isError ? 'error' : 'done';
        st.stream.toolCall.result = textOfToolResult(rec.result);
      }
      st.activity = null;
      dirty = true;
      break;
    }
    case 'message_end': {
      const m = rec.message;
      if (m && m.role === 'assistant') {
        const text = Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
        if (text) { st.lastProse = text.slice(-4000); st._followupReply = st.lastProse; }
        if (m.usage && (m.usage.totalTokens || m.usage.input)) {
          st.lastUsage = {
            ts: new Date().toISOString(),
            contextTokens: (m.usage.input || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0),
            ttl: null,
          };
        }
        st.model = m.model || st.model;
        st.modelProvider = m.provider || st.modelProvider || null;
        dirty = true;
      }
      break;
    }
    case 'compaction_start': {
      st.activity = 'Compacting';
      dirty = true;
      break;
    }
    case 'compaction_end': {
      st.activity = null;
      // The context was rebuilt: the last usage no longer describes it (cf. src/lib/promptCache.js).
      st.lastUsage = null;
      st.lastRequestAt = null;
      dirty = true;
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
      if (typeof st.onTurnEnd === 'function') { try { st.onTurnEnd(); } catch (_) {} }
      // A real turn ran (not an extension command or a compaction): suggest what comes next, as
      // Claude Code's prompt_suggestion does on the Claude path.
      if (st._turnRan) {
        st._turnRan = false;
        if (!st.pendingAsk && followupsOn()) suggestFollowup(st).catch(() => {});
      }
      break;
    }
    case 'turn_start': {
      st.stream = { text: '', thinking: '', tool: null, types: {} }; // nouveau tour : reset preview
      st.lastRequestAt = Date.now(); // a turn opens with a model request: the prompt-cache clock
      st._turnRan = true;
      st.busy = true;
      if (!st.pendingAsk) st.sdkState = 'running';
      dirty = true;
      break;
    }
    case 'session_info_changed': {
      dirty = true;
      break;
    }
    case 'extension_ui_request': {
      // Dialogs of the hooked package (permission / question / plan cards) and of other
      // extensions, plus the quotas it relays (cf. server/piHooked.js).
      if (st.pi) handleUiRequest(st, rec, (obj) => st.pi.send(obj));
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
// Driver API (agent.js calls these through the `pi` engine, cf. server/engines/pi.js)
// ---------------------------------------------------------------------------

// pi has no permission modes: in RPC the tools run directly (auto-approve).
function piModeFor() { return null; }

// Sessions folder of a provider's pi profile.
function piSessionsDirFor(provider) {
  if (provider && provider.agentDir) return path.join(expandHome(provider.agentDir), 'sessions');
  return PI_SESSIONS_DIR;
}

// The provider's own extensions (`args: ["-e", "npm:pi-claude-bridge"]`) register model providers:
// the catalog has to load them to list their models.
function extensionArgs(provider) {
  const args = provider && Array.isArray(provider.args) ? provider.args : [];
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-e' || args[i] === '--extension') && args[i + 1]) out.push('-e', args[++i]);
  }
  return out;
}

// Catalog key + spawn parameters of a provider's pi profile.
function piProfile(provider, baseEnv = process.env) {
  const bin = piBin(provider);
  const env = piEnvFor(baseEnv, provider);
  const ext = extensionArgs(provider);
  return { key: bin + '|' + (env.PI_CODING_AGENT_DIR || '') + '|' + ext.join(' '), bin, env, ext };
}

function piCatalogFor(provider, baseEnv) {
  const p = piProfile(provider, baseEnv);
  return piCatalog(p.key, p.bin, p.env, p.ext);
}

// A model reference as pi takes it: `provider/id`, or a bare id pi resolves itself (it prefers
// the provider with credentials). `modelProvider` on the provider config qualifies a bare id —
// what a cron task or a launch saved before models were qualified carries. Claude Code's aliases
// (`opus`, `sonnet`) resolve as they are through pi-claude-bridge, but its context suffix
// (`opus[1m]`) does not: pi's models carry their own window, so the suffix is dropped.
function qualifyModel(model, provider) {
  const m = model ? String(model).replace(/\[[^\]]*\]$/, '') : '';
  if (!m) return null;
  if (m.includes('/')) return m;
  return provider && provider.modelProvider ? `${provider.modelProvider}/${m}` : m;
}

// `provider/id` → { provider, modelId }; a bare id takes `fallbackProvider`.
function splitModelRef(ref, fallbackProvider = null) {
  const s = String(ref || '');
  const i = s.indexOf('/');
  if (i > 0) return { provider: s.slice(0, i), modelId: s.slice(i + 1) };
  return { provider: fallbackProvider, modelId: s };
}

const HOOKED_MCP_TOOLS = 'mcp__hooked__*';

function piArgsFor(st, { resumeId, model, effort, name }, provider) {
  const args = ['--mode', 'rpc'];
  if (resumeId) {
    const src = scanPiSessions(piSessionsDirFor(provider)).find((s) => s.id === resumeId);
    if (src && src.file) args.push('--session', src.file);
    else args.push('--session-id', resumeId);
  } else {
    const id = crypto.randomUUID();
    st.piNewId = id;
    args.push('--session-id', id);
  }
  // A new session starts on the requested model, else the provider's default, else whatever its
  // `models` scope puts first. A resumed one keeps its own (pi restores it from the session).
  const m = qualifyModel(model || (!resumeId && provider && provider.defaultModel) || null, provider);
  if (m) args.push('--model', m);
  if (!resumeId && provider && Array.isArray(provider.models) && provider.models.length) {
    args.push('--models', provider.models.join(','));
  }
  const eff = effort || (!resumeId && provider && provider.defaultEffort) || null;
  if (eff) args.push('--thinking', eff);
  if (name) args.push('--name', name);
  const extra = provider && Array.isArray(provider.args) ? [...provider.args] : [];
  // hooked's own package: tools, permission / question / plan cards, quotas (cf. pi-package/).
  if (hookedPackageEnabled(provider)) {
    extra.push('-e', hookedPiPackage());
    // The package serves hooked's tools natively (`hooked_*`, with this session's launch key). A
    // `hooked` server in pi's mcp.json would declare the same tools a second time, without the key.
    const i = extra.findIndex((a) => a === '-xt' || a === '--exclude-tools');
    if (i >= 0 && extra[i + 1]) extra[i + 1] += ',' + HOOKED_MCP_TOOLS;
    else extra.push('--exclude-tools', HOOKED_MCP_TOOLS);
  }
  args.push(...extra);
  return args;
}

async function piStart(st, opts, ctx) {
  const provider = st.providerConfig || null;
  const withPackage = hookedPackageEnabled(provider);
  // Launch mode and auto-approve travel to the package through its environment; later changes go
  // through its /hooked-mode and /hooked-auto-approve commands.
  if (withPackage && opts.permissionMode) st.permissionMode = opts.permissionMode;
  const env = {
    ...piEnvFor(opts.env || process.env, provider),
    ...(withPackage ? hookedPackageEnv(st, ctx.hookedMcp ? ctx.hookedMcp() : null) : {}),
  };
  const args = piArgsFor(st, opts, provider);
  const client = new PiRpcClient(args, { cwd: st.cwd, env, bin: piBin(provider) });
  st.pi = client;
  st.provider = st.provider || 'pi';
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
    const m0 = st0.data?.model;
    if (m0 && typeof m0 === 'object') { st.model = m0.id || st.model; st.modelProvider = m0.provider || st.modelProvider || null; }
    st.sawMsg = true;
    st.hookedPackage = withPackage;
    if (!withPackage) {
      // Without the package, pi runs every tool without asking: auto-approve, nothing to switch.
      st.autoApprove = true;
      st.permissionMode = 'bypassPermissions';
    }
    ctx.setLive(sessionId, st);
    ctx.persistLaunch(sessionId, opts.model || null, opts.effort || null);
    if (opts.prompt && String(opts.prompt).trim()) {
      piPrompt(st, String(opts.prompt).trim()).catch(() => {}); // le tour tourne en fond
      // New, unnamed session: name it from the first prompt (a resumed one keeps its name).
      if (!opts.resumeId && !opts.name && !st0.data?.sessionName) autoNamePiSession(st, String(opts.prompt));
    }
    ctx.done(st);
  } catch (e) {
    const tail = client.stderr ? ` — ${client.stderr.trim().split('\n').slice(-2).join(' ')}` : '';
    st.error = 'pi start failed: ' + ((e && e.message) || e) + tail;
    client.close();
    ctx.failStartup(st);
  }
}

// Best effort, in the background: a failed or slow call leaves the first-prompt fallback title.
// Slash commands are skipped, their text says nothing about the work. piCli.js is imported lazily
// because it imports this module back (resolvePiBin).
function autoNamePiSession(st, prompt) {
  const text = prompt.trim();
  if (!text || text.startsWith('/') || process.env.HOOKED_PI_AUTO_NAME === '0') return;
  import('./piCli.js')
    .then(({ suggestPiTitle }) => suggestPiTitle(text, st.providerConfig || null))
    .then((name) => {
      if (!name || !st.pi || st.ended) return;
      // pi appends a session_info entry to the .jsonl; the scan picks the name up from there.
      return st.pi.call('set_session_name', { name }, 15_000).then(() => { if (st._emit) st._emit(); });
    })
    .catch((e) => console.warn(`[hooked] pi auto-name: ${st.id}: ${(e && e.message) || e}`));
}

function piPrompt(st, text) {
  const client = st.pi;
  if (!client) return Promise.reject(err400('pi session not started'));
  // A new prompt: the suggestion on screen and any being computed are stale.
  st._followupSeq = (st._followupSeq || 0) + 1;
  st.followup = null;
  st._followupUser = String(text || '').slice(-4000);
  // A turn is running when the preview buffer exists (turn_start → agent_settled).
  const running = !!st.stream;
  st.busy = true;
  st.sdkState = 'running';
  if (!running) st.activity = null;
  // pi rejects a bare `prompt` while it streams ("Agent is already processing"): a message sent
  // mid-turn must say how to queue. `steer` matches Claude Code (delivered after the current tool
  // calls, before the next LLM call); pi ignores the option when idle, so it is always passed.
  // The response only acknowledges the prompt (started / queued / handled): the end of the work
  // is `agent_settled`, so busy is not cleared here unless nothing was started.
  return client.call('prompt', { message: text, streamingBehavior: 'steer' }, 60_000).then((res) => {
    if (res?.data?.disposition === 'handled' && !st.stream) {
      st.busy = false;
      if (!st.pendingAsk) st.sdkState = 'idle';
      if (st._emit) st._emit();
    }
    return res;
  }).catch((e) => {
    if (!st.stream) {
      st.busy = false;
      if (!st.pendingAsk) st.sdkState = 'idle';
    }
    console.warn(`[hooked] pi prompt: ${st.id}: ${(e && e.message) || e}`);
    if (st._emit) st._emit();
    throw e;
  });
}

function piCancel(st) {
  if (st.pi) return st.pi.call('abort', {}, 15_000).catch(() => {});
  return Promise.resolve();
}

// Manual compaction (hooked's auto-compact, or a `/compact` typed in the composer).
function piCompact(st, instructions = '') {
  if (!st.pi) return Promise.reject(err400('pi session not started'));
  return st.pi.call('compact', instructions ? { customInstructions: instructions } : {}, 600_000);
}

// An extension command of the hooked package: handled at once by pi, even mid-turn, and never
// sent to the model.
function packageCommand(st, line) {
  if (!st.pi) return Promise.reject(err400('pi session not started'));
  return st.pi.call('prompt', { message: line, streamingBehavior: 'steer' }, 15_000);
}

function piSetMode(st, target) {
  if (!st.hookedPackage) {
    // No package: pi has no permission modes, the choice is only noted for the UI.
    st.permissionMode = target || st.permissionMode;
    return Promise.resolve();
  }
  return packageCommand(st, `/hooked-mode ${target}`).then(() => { st.permissionMode = target; });
}

function piSetAutoApprove(st, on) {
  if (!st.hookedPackage) return Promise.resolve();
  return packageCommand(st, `/hooked-auto-approve ${on ? 'on' : 'off'}`).catch(() => {});
}

async function piSetConfig(st, { model, thinking }) {
  const provider = st.providerConfig || null;
  const calls = [];
  if (model) {
    const ref = qualifyModel(model, provider);
    let { provider: mp, modelId } = splitModelRef(ref, st.modelProvider || null);
    if (!mp) {
      // Bare id and no provider known yet: the catalog says which pi provider serves it.
      const hit = (await piCatalogFor(provider).catch(() => [])).find((m) => m.id === modelId);
      mp = hit ? hit.provider : null;
    }
    if (!mp) throw err400('cannot tell which pi provider serves ' + model + ': use provider/model');
    calls.push(st.pi.call('set_model', { provider: mp, modelId }, 15_000).then(() => { st.modelProvider = mp; }));
  }
  if (thinking) calls.push(st.pi.call('set_thinking_level', { level: thinking }, 15_000));
  await Promise.all(calls);
  if (model) { st.model = model; st.launchModel = model; }
  if (thinking) { st.effort = thinking; st.launchEffort = thinking; }
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
async function piFork(id, opts, ctx = {}) {
  const provider = opts.providerConfig || null;
  const src = scanPiSessions(piSessionsDirFor(provider)).find((s) => s.id === id);
  if (!src || !src.file) throw err400('pi session file not found for ' + id);
  const client = new PiRpcClient(['--mode', 'rpc', '--session', src.file], {
    cwd: opts.cwd || src.project || process.cwd(), env: piEnvFor(process.env, provider), bin: piBin(provider),
  });
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
// Launch options for the UI: the provider's models (pi catalog, filtered by its `models`
// patterns) and thinking levels.
// ---------------------------------------------------------------------------
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

async function piOptions(provider = null) {
  const catalog = await piCatalogFor(provider).catch(() => []);
  const patterns = provider && Array.isArray(provider.models) ? provider.models : null;
  const scoped = catalog.filter((m) => modelMatches(patterns, m.ref));
  const multi = new Set(scoped.map((m) => m.provider)).size > 1;
  const models = scoped.map((m) => ({
    name: m.ref,
    alias: m.ref,
    label: multi ? m.ref : m.id,
    provider: m.provider,
    contextWindow: m.contextWindow,
    images: m.images,
    thinking: m.thinking ? THINKING_LEVELS : ['off'],
  }));
  const def = provider && provider.defaultModel ? qualifyModel(provider.defaultModel, provider) : null;
  return {
    models,
    activeModel: (def && models.some((m) => m.name === def) ? def : null) || models[0]?.name || null,
    defaultEffort: (provider && provider.defaultEffort) || null,
    thinkingLevels: THINKING_LEVELS,
    // hooked's permission modes, enforced by its pi package; without it pi asks nothing.
    modes: hookedPackageEnabled(provider)
      ? [
        { id: 'default', label: 'Normal — ask before commands and edits' },
        { id: 'acceptEdits', label: 'Accept edits — ask before commands' },
        { id: 'plan', label: 'Plan — read only, then a plan to approve' },
        { id: 'bypassPermissions', label: 'Bypass — ask for nothing' },
      ]
      : [{ id: 'auto', label: 'Auto (no approvals in RPC)' }],
  };
}

// Stubs kept for agent.js's generic answer path: pi has no elicitation in RPC, so a pi session
// never has a question pending.
function elicitationContent() { return {}; }
function questionsFromSchema(schema) { return Array.isArray(schema?.questions) ? schema.questions : []; }

// Noms préfixés pi* : agent.js exporte déjà setMode/prompt/cancel… et le barrel index.js
// (`export *`) ferait disparaître les doublons en silence.
export {
  resolvePiBin, piBinaryAvailable, piSessionsDirFor, piCatalogFor, piEnvFor, qualifyModel, splitModelRef,
  piStart, piPrompt, piCancel, piCompact, piSetMode, piSetAutoApprove, piSetConfig, piKill, piFork, piModeFor, piOptions,
  elicitationContent, questionsFromSchema, PiRpcClient,
};
