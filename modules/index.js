/*
 * hooked's modules: features that live in a folder of their own (server code, API, page, agent tools,
 * docs) and can be switched off as a whole in Settings → Modules (cf. docs/modules.md).
 *
 * This list is pure (no server import): the web UI reads it for the navigation (src/lib/nav.js),
 * labels and pages, the server for the registry (server/modules.js) and the settings.
 */
// Every folder with a manifest is a module: adding one is creating its folder, removing one is
// deleting it (plus its two route files in src/routes, cf. docs/modules.md). Vite resolves the
// glob at build time, for the server bundle and the browser alike.
const found = import.meta.glob('./*/manifest.js', { eager: true, import: 'default' });

export const MODULES = Object.values(found).sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000));
export const MODULE_IDS = MODULES.map((m) => m.id);

// A module is on unless settings.modules says otherwise: a module added later starts on.
export function moduleOn(settings, id) {
  return !(settings && settings.modules && settings.modules[id] === false);
}

// The module a nav page belongs to (null for a core page).
export function moduleOfPage(page) {
  const m = MODULES.find((x) => x.page === page);
  return m ? m.id : null;
}

// settings.modules from anything: one boolean per known module, true unless false.
export function sanitizeModules(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return Object.fromEntries(MODULE_IDS.map((id) => [id, o[id] !== false]));
}
