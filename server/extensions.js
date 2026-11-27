/*
 * The extension registry (docs/extensions.md): finds, validates and loads extensions at runtime,
 * so installing, updating or removing one needs neither a rebuild nor a restart of hooked, and
 * cuts no driven session.
 *
 * Two roots: <checkout>/extensions (bundled) and $HOOKED_EXTENSIONS_DIR (installed, default
 * ~/.claude/hooked/extensions). A bundled extension wins over an installed one with the same id.
 *
 * Loading goes through a copy of the folder named after its hash (extension-cache/<id>/<hash>/src):
 * Node never unloads an ES module, and `import(entry + '?v=' + hash)` would only refresh the entry
 * file while its relative imports kept their first version. A new path per version refreshes the
 * whole graph. The old graph stays in V8's module cache: a small, accepted leak per update.
 *
 * Every hook an extension exposes (start, stop, applySettings, available, listeners, handlers) is
 * wrapped: an exception lands in the extension's `errors` and the log, never in the core.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { HOOKED_DIR } from './config.js';
import { readSettings } from './settings.js';
import { checkoutDir, modulesDir, enabledModuleIds } from './moduleState.js';
import { MODULES } from '../modules/index.js';
import { onSessionArchived } from './sessionMeta.js';
import { EXTENSION_API, buildContext } from './ext/context.js';
import { subscribeExtension, unsubscribeExtension, emitExtensionEvent } from './extensionEvents.js';
import { SHARED_RUNTIME, compileExtensionPage, extensionPageFile } from './extensionPages.js';
import { EXTENSION_ID, extensionOn } from '../src/lib/extensions.js';
import { NAV_KEYS } from '../src/lib/nav.js';

// Left to the runtime: the bundler must not try to resolve an extension at build time.
const nativeImport = (url) => import(/* @vite-ignore */ url);

const CACHE_DIR = path.join(HOOKED_DIR, 'extension-cache');
const SETTINGS_DIR = path.join(HOOKED_DIR, 'extension-settings');
const RESERVED_PAGES = new Set([...NAV_KEYS, 'deck', 'settings', 'session', 'sessions', 'api', '_ext', 'board', 'render']);
const SETTING_TYPES = ['bool', 'number', 'string', 'select', 'list'];
const MENU_WHEN = ['any', 'driven', 'live'];
const SKIPPED_ENTRIES = new Set(['test', 'node_modules', '.origin.json']);

// Pinned on globalThis: Vite re-executes this file after a change in `npm run live`, and the
// running extensions (their timers, their routes) must still be known.
const REG = (globalThis[Symbol.for('hooked.extensions')] ??= {
  booted: false,
  service: false,
  loaded: new Map(),   // id → entry
  rejected: new Map(), // dir → { id, dir, source, error }
  watchers: [],
  notify: null,
  queue: Promise.resolve(),
});

function bundledRoot() {
  if (process.env.HOOKED_BUNDLED_EXTENSIONS_DIR) return process.env.HOOKED_BUNDLED_EXTENSIONS_DIR;
  const root = checkoutDir();
  return root ? path.join(root, 'extensions') : null;
}

function installedRoot() {
  return process.env.HOOKED_EXTENSIONS_DIR || path.join(HOOKED_DIR, 'extensions');
}

function roots() {
  return [{ dir: bundledRoot(), source: 'bundled' }, { dir: installedRoot(), source: 'installed' }].filter((r) => r.dir);
}

// Folders the launcher is moving in or out (`<id>.next`, `<id>.prev`) and hidden ones are not extensions.
function candidateFolders(root) {
  let names = [];
  try { names = fs.readdirSync(root.dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) { return []; }
  return names
    .filter((n) => !n.startsWith('.') && !n.endsWith('.next') && !n.endsWith('.prev'))
    .filter((n) => fs.existsSync(path.join(root.dir, n, 'extension.json')))
    .map((n) => ({ id: n, dir: path.join(root.dir, n), source: root.source }));
}

function walkFiles(dir, rel = '') {
  const out = [];
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (d.name.startsWith('.') || (!rel && SKIPPED_ENTRIES.has(d.name))) continue;
    const r = rel ? rel + '/' + d.name : d.name;
    if (d.isDirectory()) out.push(...walkFiles(dir, r));
    else if (d.isFile()) out.push(r);
  }
  return out.sort();
}

function folderHash(dir) {
  const h = crypto.createHash('sha256');
  for (const rel of walkFiles(dir)) h.update(rel + '\0').update(fs.readFileSync(path.join(dir, rel))).update('\0');
  return h.digest('hex').slice(0, 16);
}

// ── Validation ────────────────────────────────────────────────────────────────────────────────

function settingError(s) {
  if (!s || typeof s.key !== 'string' || !s.key || typeof s.label !== 'string') return 'a setting needs key and label';
  if (!SETTING_TYPES.includes(s.type)) return `setting ${s.key}: type must be one of ${SETTING_TYPES.join(', ')}`;
  if (s.type === 'select' && !(Array.isArray(s.options) && s.options.length)) return `setting ${s.key}: select needs options`;
  return null;
}

function manifestError(m, folder) {
  if (!m || typeof m !== 'object') return 'extension.json is not an object';
  if (m.id !== folder) return `id "${m.id}" differs from its folder "${folder}"`;
  if (!EXTENSION_ID.test(m.id)) return `invalid id "${m.id}"`;
  if (typeof m.label !== 'string' || !m.label) return 'label missing';
  if (m.api !== EXTENSION_API) return `api ${m.api}, hooked offers ${EXTENSION_API}`;
  if (m.page != null) {
    if (typeof m.page.key !== 'string' || !EXTENSION_ID.test(m.page.key)) return 'page.key missing or invalid';
    if (RESERVED_PAGES.has(m.page.key)) return `page.key "${m.page.key}" is a core page`;
  }
  const c = m.contributes || {};
  for (const s of c.settings || []) { const e = settingError(s); if (e) return e; }
  for (const a of c.sessionMenu || []) {
    if (!a || typeof a.id !== 'string' || typeof a.label !== 'string' || typeof a.post !== 'string') return 'a sessionMenu entry needs id, label and post';
    if (a.when != null && !MENU_WHEN.includes(a.when)) return `sessionMenu ${a.id}: when must be one of ${MENU_WHEN.join(', ')}`;
  }
  return null;
}

const IMPORT_RE = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

// Server code may only name node:* built-ins, the page only the shared runtime; nothing may leave
// the folder. The page compiler enforces the page rule again on what it actually bundles.
function importError(dir) {
  for (const rel of walkFiles(dir)) {
    if (!/\.(m?js|cjs|svelte)$/.test(rel)) continue;
    const isPage = rel.startsWith('ui/');
    const src = fs.readFileSync(path.join(dir, rel), 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] || m[2] || m[3] || m[4];
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(path.join(dir, rel)), spec);
        if (!target.startsWith(dir + path.sep)) return `${rel}: import leaves the extension folder (${spec})`;
      } else if (isPage ? !SHARED_RUNTIME.includes(spec) : !spec.startsWith('node:')) {
        return `${rel}: import not allowed (${spec})`;
      }
    }
  }
  return null;
}

function scanFolder({ id, dir, source }) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'extension.json'), 'utf8')); } catch (e) {
    return { id, dir, source, error: 'extension.json: ' + (e.message || e) };
  }
  const error = manifestError(manifest, id) || importError(dir);
  return error ? { id, dir, source, manifest, error } : { id, dir, source, manifest, hash: folderHash(dir) };
}

// The folder that provides `id` now (bundled first), plus the installed duplicate it shadows.
function locate(id) {
  const found = roots().map((r) => ({ id, dir: path.join(r.dir, id), source: r.source }))
    .filter((f) => fs.existsSync(path.join(f.dir, 'extension.json')));
  return { winner: found[0] || null, shadowed: found.slice(1) };
}

// ── Declarative settings ──────────────────────────────────────────────────────────────────────

function coerceSetting(s, v) {
  switch (s.type) {
    case 'bool': return typeof v === 'boolean' ? [v] : [null, 'must be true or false'];
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return [null, 'must be a number'];
      if (s.min != null && v < s.min) return [null, `must be at least ${s.min}`];
      if (s.max != null && v > s.max) return [null, `must be at most ${s.max}`];
      return [v];
    }
    case 'string': return typeof v === 'string' ? [v.slice(0, 4000)] : [null, 'must be text'];
    case 'select': return s.options.some((o) => o.value === v) ? [v] : [null, 'not one of the options'];
    case 'list': return Array.isArray(v) && v.every((x) => typeof x === 'string') ? [v] : [null, 'must be a list of text'];
    default: return [null, 'unknown type'];
  }
}

// → { values, errors }: unknown keys dropped, each key checked against its schema entry.
function validateSettings(schema, input) {
  const values = {};
  const errors = {};
  for (const s of schema) {
    if (!input || !(s.key in input)) continue;
    const [v, err] = coerceSetting(s, input[s.key]);
    if (err) errors[s.key] = err;
    else values[s.key] = v;
  }
  return { values, errors };
}

function settingsFile(id) {
  return path.join(SETTINGS_DIR, id + '.json');
}

function readExtensionSettings(id, schema) {
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(settingsFile(id), 'utf8')); } catch (_) { /* defaults */ }
  const defaults = Object.fromEntries(schema.map((s) => [s.key, s.default]));
  return { ...defaults, ...validateSettings(schema, stored).values };
}

function schemaOf(manifest) {
  return manifest?.contributes?.settings || [];
}

// ── Load, start, stop ─────────────────────────────────────────────────────────────────────────

function snapshot(scan) {
  const dest = path.join(CACHE_DIR, scan.id, scan.hash, 'src');
  if (!fs.existsSync(path.join(dest, 'extension.json'))) {
    const tmp = dest + '.tmp-' + process.pid;
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const rel of walkFiles(scan.dir)) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.copyFileSync(path.join(scan.dir, rel), path.join(tmp, rel));
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  }
  return dest;
}

// The MCP server's loader, so every engine reads a tools.cjs the same way. Required from the
// checkout at call time: the server bundle does not live next to mcp/.
const loadToolDefs = (file, helpers) => createRequire(path.join(checkoutDir(), 'package.json'))('./mcp/extensionTools.cjs').loadToolDefs(file, helpers);
const STUB_HELPERS = { httpRequest: async () => ({ ok: false }), resultFrom: (r) => r };

async function loadExtension(scan) {
  const srcDir = snapshot(scan);
  const has = (rel) => fs.existsSync(path.join(srcDir, rel));
  const importFrom = async (rel) => (has(rel) ? (await nativeImport(pathToFileURL(path.join(srcDir, rel)).href)).default : null);
  const schema = schemaOf(scan.manifest);
  const entry = {
    ...scan,
    srcDir,
    lifecycle: (await importFrom('server/index.js')) || {},
    routes: {},
    running: false,
    errors: [],
    tools: has('tools.cjs') ? loadToolDefs(path.join(srcDir, 'tools.cjs'), STUB_HELPERS).map((t) => t.name) : [],
    page: null,
  };
  entry.ctx = buildContext({ id: scan.id, service: REG.service, settings: () => readExtensionSettings(scan.id, schema) });
  const apiFactory = await importFrom('api.js');
  if (apiFactory) entry.routes = apiFactory(entry.ctx) || {};
  if (scan.manifest.page) entry.page = await compileExtensionPage({ id: scan.id, hash: scan.hash, srcDir });
  return entry;
}

function guard(entry, what, fn) {
  try { return fn(); } catch (e) {
    const msg = `${what}: ${e?.message || e}`;
    entry.errors.push(msg);
    console.error(`[hooked] extension ${entry.id}: ${msg}`);
    return undefined;
  }
}

function enabled(entry, settings = readSettings()) {
  return extensionOn(settings, entry.id, entry.manifest.default);
}

function available(entry) {
  const fn = entry.lifecycle.available;
  return fn ? guard(entry, 'available', () => !!fn()) === true : true;
}

function activate(entry) {
  if (entry.running) return;
  entry.errors = [];
  entry.running = true;
  guard(entry, 'start', () => entry.lifecycle.start?.(entry.ctx));
  subscribeExtension(entry.id, entry.lifecycle.on);
}

function deactivate(entry) {
  if (!entry.running) return;
  entry.running = false;
  unsubscribeExtension(entry.id);
  guard(entry, 'stop', () => entry.lifecycle.stop?.());
}

function notify() {
  try { REG.notify?.(); } catch (_) { /* a dashboard push is best effort */ }
}

// Serialised: two reloads of the same folder must not interleave their stop / start.
function serial(task) {
  const run = REG.queue.then(task, task);
  REG.queue = run.catch(() => {});
  return run;
}

async function reloadNow(id) {
  for (const [dir, r] of REG.rejected) if (r.id === id) REG.rejected.delete(dir);
  const old = REG.loaded.get(id);
  const { winner, shadowed } = locate(id);
  for (const s of shadowed) REG.rejected.set(s.dir, { ...s, error: 'duplicate id: a bundled extension has it' });
  const scan = winner ? scanFolder(winner) : null;

  if (scan && !scan.error && old && old.hash === scan.hash && old.dir === scan.dir) return { id, state: 'unchanged' };

  let next = null;
  if (scan && !scan.error) {
    try { next = await loadExtension(scan); } catch (e) { scan.error = 'load: ' + (e?.message || e); }
  }
  // The new version is fully loaded (page compiled) before the old one stops: the gap is a few ms.
  if (old) deactivate(old);
  REG.loaded.delete(id);
  if (scan?.error) {
    REG.rejected.set(scan.dir, { id, dir: scan.dir, source: scan.source, error: scan.error });
    console.error(`[hooked] extension ${id}: rejected: ${scan.error}`);
  }
  if (next) {
    REG.loaded.set(id, next);
    if (enabled(next) && available(next)) activate(next);
    console.log(`[hooked] extension ${id}: loaded ${next.hash} (${next.source})${next.page ? `, page ${next.page.cached ? 'cached' : `compiled in ${next.page.ms} ms`}` : ''}`);
  } else if (old && !scan) {
    console.log(`[hooked] extension ${id}: unloaded`);
  }
  notify();
  return { id, state: next ? 'loaded' : scan?.error ? 'rejected' : 'removed' };
}

function reloadExtension(id) {
  if (!EXTENSION_ID.test(String(id || ''))) return Promise.reject(new Error('invalid extension id'));
  return serial(() => reloadNow(id));
}

function idsOnDisk() {
  return [...new Set(roots().flatMap(candidateFolders).map((f) => f.id))].sort();
}

async function bootExtensions({ service = false, watch = false } = {}) {
  REG.service = !!service;
  REG.booted = true;
  onSessionArchived('extensions', (sessionId) => emitExtensionEvent('session:archived', { sessionId }));
  const ids = new Set([...idsOnDisk(), ...REG.loaded.keys()]);
  for (const id of ids) await reloadExtension(id);
  if (watch) watchRoots();
}

// Starts the extensions switched on, stops the ones switched off. No restart.
function applyExtensionSettings(settings = readSettings()) {
  if (!REG.booted) return;
  for (const entry of REG.loaded.values()) {
    if (enabled(entry, settings) && available(entry)) activate(entry);
    else deactivate(entry);
  }
  notify();
}

// `npm run live`: an edit in an extension folder reloads that extension.
function watchRoots() {
  for (const w of REG.watchers.splice(0)) { try { w.close(); } catch (_) {} }
  const timers = new Map();
  for (const root of roots()) {
    try {
      fs.mkdirSync(root.dir, { recursive: true });
      const w = fs.watch(root.dir, { recursive: true }, (_ev, file) => {
        const id = String(file || '').split(path.sep)[0];
        if (!EXTENSION_ID.test(id)) return;
        clearTimeout(timers.get(id));
        timers.set(id, setTimeout(() => { timers.delete(id); reloadExtension(id).catch(() => {}); }, 300));
      });
      w.unref?.();
      REG.watchers.push(w);
    } catch (_) { /* a missing root is picked up at the next boot */ }
  }
}

function setExtensionsNotifier(fn) {
  REG.notify = fn;
}

// ── Queries ───────────────────────────────────────────────────────────────────────────────────

function isActive(entry, settings) {
  return entry.running && enabled(entry, settings) && !entry.errors.length;
}

function describe(entry, settings) {
  const m = entry.manifest;
  return {
    id: entry.id, label: m.label, version: m.version || null, description: m.description || '', icon: m.icon || 'package',
    page: m.page || null,
    pageModule: entry.page?.url || null,
    desktop: m.desktop || null,
    settings: schemaOf(m),
    sessionMenu: m.contributes?.sessionMenu || [],
    source: entry.source, legacy: false, origin: readOrigin(entry.dir), hash: entry.hash,
    enabled: enabled(entry, settings), available: available(entry), active: isActive(entry, settings),
    tools: entry.tools,
    errors: entry.errors,
  };
}

function readOrigin(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.origin.json'), 'utf8')); } catch (_) { return null; }
}

// Folders whose disk state differs from what runs, read at request time.
function pendingOnDisk() {
  const out = [];
  for (const f of roots().flatMap(candidateFolders)) {
    const e = REG.loaded.get(f.id);
    if (REG.rejected.has(f.dir)) continue;
    if (!e) { if (locate(f.id).winner?.dir === f.dir) out.push({ id: f.id, dir: f.dir, state: 'on disk, not loaded yet' }); continue; }
    if (e.dir === f.dir && folderHash(f.dir) !== e.hash) out.push({ id: f.id, dir: f.dir, state: 'changed on disk, not reloaded yet' });
  }
  for (const e of REG.loaded.values()) {
    if (!fs.existsSync(path.join(e.dir, 'extension.json'))) out.push({ id: e.id, dir: e.dir, state: 'removed from disk, still loaded' });
  }
  return out;
}

function listExtensions(settings = readSettings()) {
  return {
    api: EXTENSION_API,
    dir: installedRoot(),
    extensions: [...REG.loaded.values()].sort((a, b) => a.id.localeCompare(b.id)).map((e) => describe(e, settings)),
    rejected: [...REG.rejected.values()].map(({ id, dir, source, error }) => ({ id, dir, source, error })),
    pending: pendingOnDisk(),
  };
}

function extensionEnabled(id, settings = readSettings()) {
  const e = REG.loaded.get(id);
  return !!e && enabled(e, settings);
}

function enabledExtensionIds(settings = readSettings()) {
  return [...REG.loaded.values()].filter((e) => isActive(e, settings)).map((e) => e.id).sort();
}

function extensionAvailability() {
  return Object.fromEntries([...REG.loaded.values()].map((e) => [e.id, available(e)]));
}

// tools.cjs of the active extensions, sorted by id: the order sessions see them in.
function extensionToolFiles(settings = readSettings()) {
  return [...REG.loaded.values()]
    .filter((e) => isActive(e, settings) && e.tools.length)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({ id: e.id, file: path.join(e.srcDir, 'tools.cjs') }));
}

// The tools.cjs every new session loads, modules and extensions alike, in the order its engine has
// always seen them: by id for the MCP server, by navigation order for pi (its per-module packages
// loaded in that order). Changing either would change the prompt prefix of every session.
function sessionToolFiles(order = 'id', settings = readSettings()) {
  const mods = enabledModuleIds(settings).map((id) => ({ id, order: MODULES.find((m) => m.id === id)?.order, file: path.join(modulesDir() || '', id, 'tools.cjs') }));
  const exts = extensionToolFiles(settings).map((t) => ({ ...t, order: REG.loaded.get(t.id).manifest.page?.order }));
  const rank = (x) => (order === 'page' ? x.order ?? 1000 : 0);
  return [...mods.filter((m) => fs.existsSync(m.file)), ...exts]
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
    .map((x) => x.file);
}

function extensionLabel(id) {
  return REG.loaded.get(id)?.manifest.label || id;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────

const jsonError = (status, error, extra = {}) => Response.json({ ok: false, error, ...extra }, { status });

// /api/<id>/<rest>: null when no extension has that id (the caller answers its usual 404).
async function dispatchExtensionRoute(id, rest, request) {
  const entry = REG.loaded.get(id);
  if (!entry) return null;
  if (!enabled(entry)) return jsonError(404, `the ${entry.manifest.label} extension is off (Settings → Extensions)`, { code: 'extension_off' });
  const route = entry.routes[rest || ''];
  if (!route) return jsonError(404, 'not found');
  const handler = route[request.method];
  if (typeof handler !== 'function') return jsonError(405, 'method not allowed');
  try {
    return await handler(request, entry.ctx);
  } catch (e) {
    console.error(`[hooked] extension ${id}: ${request.method} /api/${id}/${rest}: ${e?.stack || e}`);
    return jsonError(500, e?.message || String(e));
  }
}

function getExtensionSettings(id) {
  const entry = REG.loaded.get(id);
  if (!entry) return null;
  const schema = schemaOf(entry.manifest);
  return { schema, values: readExtensionSettings(id, schema) };
}

// → { values } or { errors } (per key). Written atomically, then handed to the extension.
function saveExtensionSettings(id, input) {
  const entry = REG.loaded.get(id);
  if (!entry) return { errors: { _: 'unknown extension' } };
  const schema = schemaOf(entry.manifest);
  const { values: patch, errors } = validateSettings(schema, input);
  if (Object.keys(errors).length) return { errors };
  const values = { ...readExtensionSettings(id, schema), ...patch };
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  const tmp = settingsFile(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, settingsFile(id));
  if (entry.running) guard(entry, 'applySettings', () => entry.lifecycle.applySettings?.(values));
  notify();
  return { values };
}

export {
  bootExtensions, reloadExtension, applyExtensionSettings, listExtensions, extensionEnabled,
  enabledExtensionIds, extensionAvailability, extensionToolFiles, sessionToolFiles, extensionLabel, dispatchExtensionRoute,
  getExtensionSettings, saveExtensionSettings, setExtensionsNotifier, emitExtensionEvent,
  extensionPageFile,
};
