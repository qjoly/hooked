/*
 * Provider configuration: the pure part of the provider registry (server/providers.js).
 *
 * Two layers, deliberately separate:
 *   - an ENGINE is code: what drives one kind of agent CLI and reads its sessions back
 *     (`claude` = Agent SDK, `pi` = pi RPC, `acp` = any Agent Client Protocol agent, or an
 *     external module dropped in the providers folder);
 *   - a PROVIDER is configuration: what the dashboard shows and launches. It names an engine and
 *     carries everything that is customisable — label, badge, colour, binary, arguments,
 *     environment, model filters, defaults, capability overrides, engine options.
 *
 * Providers live in settings.json under `providers`, keyed by id. A bare string is the historical
 * shorthand for the enabled mode ('auto' | 'on' | 'off'), so an existing settings file keeps
 * working unchanged:
 *
 *   "providers": {
 *     "claude": "auto",
 *     "pi": { "enabled": "on", "label": "Mistral", "models": ["mistral/*"] },
 *     "gemini": { "engine": "acp", "label": "Gemini", "command": "gemini", "args": ["--experimental-acp"] }
 *   }
 *
 * Everything here is pure (no fs, no settings read) so it is tested without an environment.
 */

// Built-in providers: always present (a settings entry only overrides their fields). Their engine
// is fixed — a settings entry cannot point `claude` at another engine. No default colour: badges
// stay neutral (claude) / accent (others) unless the settings give one.
const BUILTIN_PROVIDERS = {
  claude: {
    engine: 'claude',
    label: 'Claude',
    short: 'cc',
    description: 'Claude Code, driven through the Agent SDK.',
  },
  pi: {
    engine: 'pi',
    label: 'Pi',
    short: 'pi',
    description: 'pi coding agent, driven in RPC mode (any model pi is signed in to).',
  },
};

const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ENABLED_MODES = ['auto', 'on', 'off'];
const MODEL_REF_RE = /^[A-Za-z0-9._:/@+-]{1,160}$/;
const MODEL_GLOB_RE = /^[A-Za-z0-9._:/@+*?[\]!-]{1,160}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SHORT_RE = /^[A-Za-z0-9+._-]{1,4}$/;

// Capability keys a provider can override. The engine declares its defaults; a provider entry can
// only switch them off/on (`capabilities: { plan: false }`), e.g. to hide a control the agent
// behind an ACP adapter does not really honour.
const CAPABILITY_KEYS = [
  'permissions',    // tool permission requests reach the dashboard
  'questions',      // the agent can ask the user a question
  'plan',           // plan mode (approve / keep planning)
  'modes',          // permission modes can be switched
  'autoApprove',    // the per-session auto-approve switch means something
  'models',         // a model can be picked / switched
  'effort',         // an effort / thinking level can be picked
  'resume',         // a finished session can be resumed
  'fork',           // a session can be forked
  'forkAtMessage',  // ... from a given message
  'worktree',       // launch in a new git worktree
  'ephemeral',      // archive-after-turn note
  'images',         // pasted images are understood
  'todos', 'subagents', 'backgroundJobs', 'workflows', 'screenshots', 'subSessions',
  'trace', 'search', 'trash',
  'rateLimits',     // account rate-limit gauges
  'promptCache',    // the prompt-cache clock is meaningful
  'commands',       // « / » commands
  'skills',
  'mcp',            // MCP lens
  'mcpLogin',       // OAuth login from the MCP lens
  'memory', 'plugins', 'remoteControl', 'account',
];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function enabledMode(v) {
  return ENABLED_MODES.includes(v) ? v : 'auto';
}

// One raw settings entry → sanitized entry, or null when it cannot describe a provider.
// `id` decides whether it is a built-in (engine forced) or a custom one (engine required).
function sanitizeEntry(id, raw) {
  const builtin = BUILTIN_PROVIDERS[id];
  if (typeof raw === 'string' || raw == null) {
    // Shorthand: only the enabled mode. A custom provider needs at least an engine.
    return builtin ? enabledMode(raw) : null;
  }
  if (!isObj(raw)) return builtin ? 'auto' : null;
  const out = { enabled: enabledMode(raw.enabled) };
  const engine = builtin ? builtin.engine : str(raw.engine, 32);
  if (!builtin) {
    if (!PROVIDER_ID_RE.test(engine)) return null;
    out.engine = engine;
  }
  const label = str(raw.label, 40);
  if (label) out.label = label;
  const short = str(raw.short, 4);
  if (short && SHORT_RE.test(short)) out.short = short;
  const color = str(raw.color, 9);
  if (color && COLOR_RE.test(color)) out.color = color;
  const description = str(raw.description, 300);
  if (description) out.description = description;
  const command = str(raw.command, 4096);
  if (command) out.command = command;
  if (Array.isArray(raw.args)) {
    const args = raw.args.filter((a) => typeof a === 'string' && a.length <= 4096).slice(0, 64);
    if (args.length) out.args = args;
  }
  if (isObj(raw.env)) {
    const env = {};
    for (const [k, v] of Object.entries(raw.env).slice(0, 64)) {
      if (ENV_KEY_RE.test(k) && typeof v === 'string' && v.length <= 8192) env[k] = v;
    }
    if (Object.keys(env).length) out.env = env;
  }
  if (Array.isArray(raw.models)) {
    const models = [...new Set(raw.models.filter((m) => typeof m === 'string' && MODEL_GLOB_RE.test(m)))].slice(0, 64);
    if (models.length) out.models = models;
  }
  if (Array.isArray(raw.hiddenModels)) {
    out.hiddenModels = [...new Set(raw.hiddenModels.filter((m) => typeof m === 'string' && MODEL_REF_RE.test(m)))].slice(0, 128);
  }
  for (const k of ['defaultModel', 'defaultEffort', 'titleModel', 'modelProvider']) {
    if (typeof raw[k] !== 'string') continue;
    const v = raw[k].trim();
    // '' is meaningful for titleModel (switches auto-naming off): keep it.
    if (v === '' && k === 'titleModel') out[k] = '';
    else if (MODEL_REF_RE.test(v)) out[k] = v;
  }
  const agentDir = str(raw.agentDir, 4096);
  if (agentDir && /^(\/|~\/)/.test(agentDir)) out.agentDir = agentDir;
  if (isObj(raw.modes)) {
    const modes = {};
    for (const [k, v] of Object.entries(raw.modes).slice(0, 16)) {
      if (/^[A-Za-z]{1,32}$/.test(k) && typeof v === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(v)) modes[k] = v;
    }
    if (Object.keys(modes).length) out.modes = modes;
  }
  if (typeof raw.injectHookedMcp === 'boolean') out.injectHookedMcp = raw.injectHookedMcp;
  if (typeof raw.hookedPackage === 'boolean') out.hookedPackage = raw.hookedPackage;
  if (isObj(raw.capabilities)) {
    const caps = {};
    for (const k of CAPABILITY_KEYS) if (typeof raw.capabilities[k] === 'boolean') caps[k] = raw.capabilities[k];
    if (Object.keys(caps).length) out.capabilities = caps;
  }
  // Free-form engine options (external engines read them). Bounded and JSON-only.
  if (isObj(raw.options)) {
    try {
      const json = JSON.stringify(raw.options);
      if (json.length <= 16384) out.options = JSON.parse(json);
    } catch (_) { /* not serialisable: dropped */ }
  }
  return out;
}

// settings.providers (any shape) → sanitized map. Built-ins are always present; a built-in left
// with nothing but its mode stays a bare string (the historical shape, read by older clients).
function sanitizeProviders(raw) {
  const src = isObj(raw) ? raw : {};
  const out = {};
  for (const id of Object.keys(BUILTIN_PROVIDERS)) {
    const e = sanitizeEntry(id, src[id]);
    out[id] = isObj(e) && Object.keys(e).length === 1 ? e.enabled : e;
  }
  for (const [id, v] of Object.entries(src).slice(0, 48)) {
    if (BUILTIN_PROVIDERS[id] || !PROVIDER_ID_RE.test(id)) continue;
    const e = sanitizeEntry(id, v);
    if (e) out[id] = e;
  }
  return out;
}

// Enabled mode of a sanitized entry (string shorthand or object).
function entryMode(entry) {
  return typeof entry === 'string' ? enabledMode(entry) : enabledMode(entry && entry.enabled);
}

// Sanitized settings map → resolved provider list, in settings order (built-ins first).
// Each item: { id, engine, builtin, enabled, label, short, color, description, ...options }.
function resolveProviders(settingsProviders) {
  const map = sanitizeProviders(settingsProviders);
  const out = [];
  for (const [id, entry] of Object.entries(map)) {
    const base = BUILTIN_PROVIDERS[id] || {};
    const e = isObj(entry) ? entry : {};
    out.push({
      ...base,
      ...e,
      id,
      engine: base.engine || e.engine,
      builtin: !!BUILTIN_PROVIDERS[id],
      enabled: entryMode(entry),
      label: e.label || base.label || defaultLabel(id),
      short: e.short || base.short || id.slice(0, 2),
      color: e.color || base.color || null,
    });
  }
  return out;
}

function defaultLabel(id) {
  return id.split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

// Applies the 'auto' | 'on' | 'off' setting on top of auto-detection.
function applyProviderOverride(autoDetected, setting) {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return autoDetected;
}

// Case-insensitive glob: `*` any run, `?` one character, `[abc]` a class. Anchored.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) { re += '\\['; continue; }
      let cls = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      re += '[' + cls + ']';
      i = end;
    } else re += c.replace(/[.+^${}()|\\/-]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

// Does a model reference match one of the patterns? A pattern with a `/` matches the full
// `provider/model` reference; one without matches the model id alone (whatever the provider).
// No patterns = everything matches.
function modelMatches(patterns, ref) {
  if (!Array.isArray(patterns) || !patterns.length) return true;
  const full = String(ref || '');
  if (!full) return false;
  const bare = full.includes('/') ? full.slice(full.indexOf('/') + 1) : full;
  return patterns.some((p) => globToRegExp(p).test(p.includes('/') ? full : bare));
}

// Which provider owns a session, among the providers built on the same engine (and reading the
// same session store)? The first one whose `models` patterns match the session's model wins; a
// provider without patterns is the catch-all, and gets what no filtered provider claimed. Order is
// the settings order, so a narrower custom provider placed after a built-in catch-all still wins:
// filtered providers are always tried before catch-alls.
function attributeSession(providers, modelRef) {
  const filtered = providers.filter((p) => Array.isArray(p.models) && p.models.length);
  for (const p of filtered) if (modelRef && modelMatches(p.models, modelRef)) return p.id;
  const catchAll = providers.find((p) => !Array.isArray(p.models) || !p.models.length);
  return catchAll ? catchAll.id : (providers[0] ? providers[0].id : null);
}

// Merged capabilities: engine defaults, then the provider's overrides.
function mergeCapabilities(engineCaps, overrides) {
  const out = {};
  for (const k of CAPABILITY_KEYS) out[k] = !!(engineCaps && engineCaps[k]);
  if (isObj(overrides)) for (const k of CAPABILITY_KEYS) if (typeof overrides[k] === 'boolean') out[k] = overrides[k];
  return out;
}

// Environment for a provider's subprocess: base env, then the provider's `env` (an empty value
// removes the variable — the way to keep an exported variable away from one agent).
function providerEnv(base, provider) {
  const env = { ...(base || {}) };
  const extra = provider && isObj(provider.env) ? provider.env : {};
  for (const [k, v] of Object.entries(extra)) {
    if (v === '') delete env[k];
    else env[k] = v;
  }
  return env;
}

export {
  BUILTIN_PROVIDERS, PROVIDER_ID_RE, CAPABILITY_KEYS, MODEL_REF_RE,
  sanitizeProviders, resolveProviders, entryMode, applyProviderOverride,
  globToRegExp, modelMatches, attributeSession, mergeCapabilities, providerEnv,
};
