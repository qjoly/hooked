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
import cron from '../modules/cron/server/index.js';
import flows from '../modules/flows/server/index.js';
import github from '../modules/github/server/index.js';

const HOOKS = { cron, flows, github };

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

export { bootModules, applyModuleSettings };
export { moduleEnabled, enabledModuleIds, modulePiPackages, listModules, modulesDir } from './moduleState.js';
