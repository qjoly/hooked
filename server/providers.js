/*
 * Provider registry: which agents hooked can drive, and which code drives them.
 *
 *   ENGINES   (code)   claude (Agent SDK, built-in driver in agent.js), pi (pi RPC), acp (any Agent
 *                      Client Protocol agent), plus external engine modules dropped in the
 *                      providers folder (HOOKED_PROVIDERS_DIR, default ~/.claude/hooked/providers).
 *   PROVIDERS (config) settings.json `providers` — built-ins `claude` and `pi`, plus any custom
 *                      entry naming an engine. Everything a user can tune lives there (cf.
 *                      server/providerConfig.js and docs/providers.md).
 *
 * The rest of hooked asks this module instead of testing provider ids: `engineForSession(s)` for
 * the session store (conversation, trace, todos…), `driverFor(st)` for the live driver,
 * `providerList()` for the UI. A provider is shown when it is enabled: 'auto' = its engine detects
 * the agent on this machine (memoised 30 s), 'on' = forced, 'off' = hidden and not launchable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSettings } from './settings.js';
import { HOOKED_DIR } from './config.js';
import {
  BUILTIN_PROVIDERS, resolveProviders, applyProviderOverride, mergeCapabilities, attributeSession,
  modelMatches, providerEnv,
} from './providerConfig.js';
import { claudeEngine } from './engines/claude.js';
import { piEngine } from './engines/pi.js';
import { acpEngine, AcpClient } from './engines/acp.js';
import * as journal from './engines/journal.js';

// Pinned on globalThis: under `npm run live`, Vite re-executes this module after an edit, and the
// external engines (loaded asynchronously from disk) must not vanish with it.
const REG_KEY = Symbol.for('hooked.providers.registry');
const REG = globalThis[REG_KEY] || (globalThis[REG_KEY] = {
  engines: new Map(),
  external: { dir: null, loaded: false, promise: null, errors: [], files: [] },
  detect: new Map(),
});

const ENGINE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const DRIVER_METHODS = ['start', 'prompt', 'cancel', 'kill'];

function registerEngine(engine, { builtin = false } = {}) {
  if (!engine || typeof engine !== 'object' || !ENGINE_ID_RE.test(engine.id || '')) {
    throw new Error('an engine needs an `id` matching ' + ENGINE_ID_RE);
  }
  const prev = REG.engines.get(engine.id);
  if (prev && prev.builtin && !builtin) throw new Error(`engine id "${engine.id}" is reserved by a built-in engine`);
  if (engine.driver) {
    for (const m of DRIVER_METHODS) {
      if (typeof engine.driver[m] !== 'function') throw new Error(`engine ${engine.id}: driver.${m}() is required`);
    }
  }
  REG.engines.set(engine.id, { ...engine, builtin: !!builtin });
  REG.detect.clear();
}

// Built-ins are (re)registered on every module evaluation, lazily: an import cycle can reach this
// module before the engine modules finished evaluating.
let builtinsReady = false;
function ensureBuiltins() {
  if (builtinsReady) return;
  builtinsReady = true;
  for (const e of [claudeEngine, piEngine, acpEngine]) registerEngine(e, { builtin: true });
}

function getEngine(id) {
  ensureBuiltins();
  return REG.engines.get(id) || null;
}

function listEngines() {
  ensureBuiltins();
  return [...REG.engines.values()];
}

// ── Providers ─────────────────────────────────────────────────────────────────────────────────
function providerConfigs() {
  let raw = {};
  try { raw = readSettings().providers || {}; } catch (_) { /* defaults */ }
  return resolveProviders(raw);
}

function getProvider(id) {
  if (!id) return null;
  return providerConfigs().find((p) => p.id === id) || null;
}

function engineOf(providerId) {
  const p = getProvider(providerId);
  return p ? getEngine(p.engine) : null;
}

// Engine of a scanned session (or a registry entry): its provider's, else the engine it was read
// by, else the historical rule (pi sessions are pi, everything else Claude).
function engineForSession(s) {
  if (!s) return getEngine('claude');
  return engineOf(s.provider) || (s.engine && getEngine(s.engine)) || getEngine(s.provider === 'pi' ? 'pi' : 'claude');
}

// The live driver of a registry entry, or null for the built-in Claude path.
function driverFor(st) {
  if (!st) return null;
  const e = engineForSession(st);
  return e && e.driver ? e.driver : null;
}

// Auto-detection, memoised 30 s per provider (it spawns `which`).
function detected(p) {
  const engine = getEngine(p.engine);
  if (!engine) return false;
  const key = p.id + '|' + (p.command || '') + '|' + (p.agentDir || '');
  const c = REG.detect.get(key);
  if (c && Date.now() - c.at < 30_000) return c.value;
  let value = false;
  try { value = typeof engine.detect === 'function' ? !!engine.detect(p) : true; } catch (_) { value = false; }
  REG.detect.set(key, { at: Date.now(), value });
  return value;
}

function isEnabled(p) {
  return applyProviderOverride(detected(p), p.enabled);
}

// { [id]: boolean } — enabled providers after detection + settings. Historical shape: the UI and
// the desktop app read `.claude` / `.pi`, and every other provider simply adds a key.
function configuredProviders() {
  const out = {};
  for (const p of providerConfigs()) out[p.id] = isEnabled(p);
  return out;
}

function isProviderEnabled(id) {
  const p = getProvider(id);
  return !!p && isEnabled(p);
}

// Why `id` cannot be launched right now (a sentence for a 400), or null.
function providerLaunchError(id) {
  const p = getProvider(id);
  if (!p) return `unknown provider: ${id}`;
  if (p.enabled === 'off') return `the ${id} provider is disabled in the hooked settings (providers.${id} = "off")`;
  const engine = getEngine(p.engine);
  if (!engine) {
    return REG.external.loaded
      ? `provider ${id} uses engine "${p.engine}", which is not installed (no such module in ${externalDir()})`
      : `provider ${id} uses engine "${p.engine}", which is still loading`;
  }
  if (p.engine !== 'claude' && !engine.driver) return `engine ${p.engine} cannot drive sessions`;
  const why = typeof engine.available === 'function' ? engine.available(p) : null;
  return why || null;
}

// Provider for a launch that names none: settings.defaultProvider when it is usable, else the
// first enabled provider, else claude.
function defaultProviderId() {
  let wanted = 'claude';
  try { wanted = readSettings().defaultProvider || 'claude'; } catch (_) {}
  if (isProviderEnabled(wanted)) return wanted;
  const first = providerConfigs().find((p) => isEnabled(p));
  return first ? first.id : 'claude';
}

// An engine's capabilities for one provider: `capabilitiesFor(provider)` when the engine depends on
// the provider's options (pi with or without hooked's package), else its static set.
function engineCaps(engine, p) {
  if (!engine) return null;
  return typeof engine.capabilitiesFor === 'function' ? engine.capabilitiesFor(p) : engine.capabilities;
}

function capabilitiesOf(providerId) {
  const p = getProvider(providerId);
  const engine = p ? getEngine(p.engine) : null;
  return mergeCapabilities(engineCaps(engine, p), p && p.capabilities);
}

// Provider list for the UI (GET /api/providers, /api/sessions → providerList).
function providerList() {
  return providerConfigs().map((p) => {
    const engine = getEngine(p.engine);
    return {
      id: p.id,
      engine: p.engine,
      engineLabel: engine ? engine.label || engine.id : null,
      engineMissing: !engine,
      builtin: p.builtin,
      label: p.label,
      short: p.short,
      color: p.color,
      description: p.description || null,
      mode: p.enabled,
      detected: engine ? detected(p) : false,
      enabled: engine ? isEnabled(p) : false,
      mcpKind: engine ? engine.mcpKind || null : null,
      skillsKind: engine ? engine.skillsKind || null : null,
      defaultModel: p.defaultModel || null,
      defaultEffort: p.defaultEffort || null,
      models: p.models || null,
      hiddenModels: p.hiddenModels || null,
      capabilities: mergeCapabilities(engineCaps(engine, p), p.capabilities),
    };
  });
}

// Launch options of a provider for the pickers ({ models, activeModel, thinkingLevels, modes }).
// Claude's come from the capabilities of its binary (/api/defaults): `{ claude: true }` here.
async function providerOptions(id) {
  const p = getProvider(id);
  if (!p) return { provider: id, error: 'unknown provider', models: [], thinkingLevels: [], modes: [] };
  const e = getEngine(p.engine);
  if (!e) return { provider: id, error: `engine ${p.engine} is not installed`, models: [], thinkingLevels: [], modes: [] };
  if (e.id === 'claude') return { provider: id, claude: true };
  let opts = {};
  try { opts = typeof e.options === 'function' ? (await e.options(p)) || {} : {}; } catch (err) { opts = { error: (err && err.message) || String(err) }; }
  return { models: [], thinkingLevels: [], modes: [], ...opts, provider: id };
}

// ── Sessions of every provider ────────────────────────────────────────────────────────────────
// Providers sharing an engine AND a session store (pi providers on the same agent dir) are scanned
// once, and each session is attributed by its model (attributeSession). Sessions of a disabled
// provider stay listed: switching a provider off hides it from the launch pickers, not the history.
function scanProviderSessions() {
  const groups = new Map(); // engineId|storeKey -> { engine, providers }
  for (const p of providerConfigs()) {
    const engine = getEngine(p.engine);
    if (!engine || typeof engine.scan !== 'function') continue;
    const key = engine.id + '|' + (typeof engine.storeKey === 'function' ? engine.storeKey(p) : '');
    const g = groups.get(key) || { engine, providers: [] };
    g.providers.push(p);
    groups.set(key, g);
  }
  const out = [];
  const seen = new Set();
  for (const { engine, providers } of groups.values()) {
    let list = [];
    try { list = engine.scan(providers[0]) || []; } catch (e) { console.warn(`[hooked] ${engine.id} scan: ${(e && e.message) || e}`); }
    for (const s of list) {
      if (!s || !s.id || seen.has(s.id)) continue;
      seen.add(s.id);
      const ref = typeof engine.modelRef === 'function' ? engine.modelRef(s) : s.model;
      s.provider = providers.length === 1 ? providers[0].id : attributeSession(providers, ref);
      s.engine = engine.id;
      out.push(s);
    }
  }
  return out;
}

// ── External engines ──────────────────────────────────────────────────────────────────────────
function externalDir() {
  return process.env.HOOKED_PROVIDERS_DIR || path.join(HOOKED_DIR, 'providers');
}

// What an external module gets to build on: the journal store (free session list / conversation
// / trace / trash), the ACP client, and the config helpers.
const ENGINE_API = Object.freeze({
  journal,
  AcpClient,
  providerEnv,
  modelMatches,
  log: (...a) => console.log('[hooked:provider]', ...a),
});

// A module exports its engine as `default`, as `engine`, or as `createEngine(api)` (sync or async).
async function engineFromModule(mod) {
  if (mod && typeof mod.createEngine === 'function') return mod.createEngine(ENGINE_API);
  if (mod && typeof mod.default === 'function') return mod.default(ENGINE_API);
  return (mod && (mod.engine || mod.default)) || null;
}

// Loads every `*.js` / `*.mjs` file (or folder with an index.js / index.mjs) of the providers
// folder. Idempotent; called at boot (hooks.server.js) before driven sessions are resumed. Errors
// are kept for the settings page instead of failing the boot.
function loadExternalEngines(dir = externalDir(), { force = false } = {}) {
  ensureBuiltins();
  if (REG.external.promise && !force && REG.external.dir === dir) return REG.external.promise;
  REG.external.dir = dir;
  REG.external.loaded = false;
  REG.external.errors = [];
  REG.external.files = [];
  REG.external.promise = (async () => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { entries = []; }
    for (const ent of entries) {
      let file = null;
      if (ent.isFile() && /\.(m?js)$/.test(ent.name)) file = path.join(dir, ent.name);
      else if (ent.isDirectory()) {
        file = ['index.mjs', 'index.js'].map((f) => path.join(dir, ent.name, f)).find((f) => fs.existsSync(f)) || null;
      }
      if (!file) continue;
      try {
        const url = pathToFileURL(file).href + (force ? `?t=${Date.now()}` : '');
        const mod = await import(/* @vite-ignore */ url);
        const engine = await engineFromModule(mod);
        if (!engine) throw new Error('the module exports no engine (default, `engine` or `createEngine`)');
        registerEngine(engine);
        REG.external.files.push({ file, engine: engine.id });
      } catch (e) {
        REG.external.errors.push({ file, error: (e && e.message) || String(e) });
        console.warn(`[hooked] provider module ${file}: ${(e && e.message) || e}`);
      }
    }
    REG.external.loaded = true;
    return REG.external.files;
  })();
  return REG.external.promise;
}

function externalEngineStatus() {
  return { dir: REG.external.dir || externalDir(), loaded: REG.external.loaded, files: REG.external.files, errors: REG.external.errors };
}

export {
  applyProviderOverride, configuredProviders, BUILTIN_PROVIDERS,
  registerEngine, getEngine, listEngines, providerConfigs, getProvider, engineOf, engineForSession, driverFor,
  isProviderEnabled, providerLaunchError, defaultProviderId, capabilitiesOf, providerList, providerOptions,
  scanProviderSessions, loadExternalEngines, externalEngineStatus, externalDir,
};
