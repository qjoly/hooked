/*
 * Lifecycle of hooked's modules (cf. modules/index.js, docs/modules.md): each module's background
 * loops start when it is on and stop when it is switched off, without a restart.
 *
 * Every module has a `server/index.js` exporting { start({ service, settings }), stop(),
 * applySettings(settings) }, all optional. `service` says whether this process is the installed
 * service (loops that launch sessions only run there) or a bare `npm run live`.
 */
import { readSettings } from './settings.js';
import { moduleOn } from '../modules/index.js';
// Every module's lifecycle, found by its folder: '../modules/<id>/server/index.js' → id.
const found = import.meta.glob('../modules/*/server/index.js', { eager: true, import: 'default' });
const HOOKS = Object.fromEntries(Object.entries(found).map(([file, hooks]) => [file.split('/')[2], hooks || {}]));

// Pinned on globalThis: Vite re-executes this file after a change in `npm run live`, and the
// loops it started must still be known as running.
const REG = (globalThis[Symbol.for('hooked.modules')] ??= { booted: false, service: false, running: new Set() });

function bootModules({ service = false } = {}) {
  REG.booted = true;
  REG.service = !!service;
  applyModuleSettings(readSettings());
}

// Starts the modules switched on, stops the ones switched off, and hands the settings to the rest.
function applyModuleSettings(settings = readSettings()) {
  if (!REG.booted) return;
  for (const [id, hooks] of Object.entries(HOOKS)) {
    const on = moduleOn(settings, id);
    try {
      if (on && !REG.running.has(id)) {
        REG.running.add(id);
        hooks.start?.({ service: REG.service, settings });
      } else if (!on && REG.running.has(id)) {
        REG.running.delete(id);
        hooks.stop?.();
      } else if (on) {
        hooks.applySettings?.(settings);
      }
    } catch (e) {
      console.error(`[hooked] module ${id}: ${e.message || e}`);
    }
  }
}

// Whether each module can work on this machine (incident.io needs its desktop app): { id: bool }.
// A module that does not say is available.
function moduleAvailability() {
  return Object.fromEntries(Object.entries(HOOKS).map(([id, h]) => {
    try { return [id, h.available ? !!h.available() : true]; } catch (_) { return [id, false]; }
  }));
}

export { bootModules, applyModuleSettings, moduleAvailability };
export { moduleEnabled, enabledModuleIds, modulePiPackages, listModules, modulesDir } from './moduleState.js';
