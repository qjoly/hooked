// The extensions as the server runs them (GET /api/extensions), refreshed on the `extensionsChanged`
// SSE event. Nothing about extensions is known at build time: an extension installed after the
// build shows up here, with its page, its settings and its session menu actions.
import { jget, jpost } from './api.js';
import { flash } from './flash.svelte.js';

export const extensions = $state({ list: [], rejected: [], pending: [], loaded: false });
const settingsValues = $state({});

let pending = null;
function setList(r) {
  extensions.list = r.extensions || [];
  extensions.rejected = r.rejected || [];
  extensions.pending = r.pending || [];
}

export function loadExtensions() {
  pending = jget('/api/extensions')
    .then((r) => {
      setList(r);
      extensions.loaded = true;
      for (const id of Object.keys(settingsValues)) loadExtensionSettings(id);
    })
    // Not loaded: the next extensionsReady() asks again, instead of a page that stays "not installed".
    .catch(() => { pending = null; });
  return pending;
}

export function extensionsReady() {
  return extensions.loaded ? Promise.resolve() : pending || loadExtensions();
}

// The navigation entries of extension pages, in the shape of src/lib/nav.js tabs.
export function extensionTabs() {
  return extensions.list.filter((e) => e.page).map((e) => ({
    key: e.page.key, label: e.label, icon: e.icon, href: '/' + e.page.key,
    tint: e.page.tint || 'var(--accent)', order: e.page.order ?? 1000, extension: e.id,
  }));
}

async function loadExtensionSettings(id) {
  try { settingsValues[id] = (await jget('/api/extensions/settings?id=' + encodeURIComponent(id))).values; } catch (_) { /* keep */ }
}

// The declarative settings of one extension, reactive (for its page). Writes state on first use:
// call it from a script or an effect, not from markup.
export function extensionSettings(id) {
  if (!(id in settingsValues)) { settingsValues[id] = {}; loadExtensionSettings(id); }
  return settingsValues[id];
}

// Read-only twin of extensionSettings, safe in markup: {} until extensionSettings(id) has loaded it.
export function extensionSettingsIfLoaded(id) {
  return settingsValues[id] || {};
}

export async function saveExtensionSettings(id, values) {
  const r = await jpost('/api/extensions/settings', { id, values });
  if (r.ok) settingsValues[id] = r.data.values;
  return r;
}

export async function setExtensionEnabled(id, enabled) {
  const r = await jpost('/api/extensions', { id, enabled });
  if (r.status === 200) setList(r.data);
  return r;
}

// Session menu entries of the active extensions for one session, filtered by `when`.
export function sessionMenuActions(session) {
  const out = [];
  for (const e of extensions.list) {
    if (!e.active) continue;
    for (const a of e.sessionMenu || []) {
      const when = a.when || 'any';
      if (when === 'driven' && !session?.driven && !session?.live) continue;
      if (when === 'live' && !session?.live) continue;
      out.push({ ...a, extension: e.id });
    }
  }
  return out;
}

// POST /api/<id>/<post> { sessionId }. The answer may carry flash, error or open.
export async function runSessionAction(action, sessionId, goto) {
  const r = await jpost(`/api/${action.extension}/${action.post}`, { sessionId });
  const d = r.data || {};
  if (d.error || r.status >= 400) return flash(d.error || 'HTTP ' + r.status, true);
  if (d.flash) flash(d.flash);
  if (d.open?.session) goto('/session/' + encodeURIComponent(d.open.session));
  else if (d.open?.page) goto('/' + d.open.page + (d.open.rest ? '/' + d.open.rest : ''));
}

// The compiled page of an extension. The shared runtime is loaded first, and only then: a user
// who never opens an extension page never downloads it.
export async function loadExtensionPage(url) {
  await import('./ext/runtime.js');
  return (await import(/* @vite-ignore */ url)).default;
}
