/*
 * Which of hooked's modules are switched on, and where their files are (cf. modules/index.js,
 * docs/modules.md). Read-only and free of module imports, so the session drivers (agent.js,
 * piAgent.js) can ask it without loading the modules themselves.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readSettings } from './settings.js';
import { MODULES, MODULE_IDS, moduleOn } from '../modules/index.js';

// The repo root can't be derived from import.meta.dirname alone: in dev this file runs from
// <repo>/server, the prod bundle from build/server/chunks. process.cwd() first: `npm run live` and
// `node build` both run at the repo root.
const ROOT_CANDIDATES = [
  process.cwd(),
  path.join(import.meta.dirname, '..'),
  path.join(import.meta.dirname, '..', '..'),
  path.join(import.meta.dirname, '..', '..', '..'),
];

// Absolute path of hooked's checkout (the folder holding modules/index.js), or null.
function checkoutDir() {
  for (const root of ROOT_CANDIDATES) {
    try { if (fs.statSync(path.join(root, 'modules', 'index.js')).isFile()) return root; } catch (_) { /* next */ }
  }
  return null;
}

// Absolute path of the modules folder, or null.
function modulesDir() {
  if (process.env.HOOKED_MODULES_DIR) return process.env.HOOKED_MODULES_DIR;
  const root = checkoutDir();
  return root ? path.join(root, 'modules') : null;
}

function moduleEnabled(id, settings = readSettings()) {
  return MODULE_IDS.includes(id) && moduleOn(settings, id);
}

function enabledModuleIds(settings = readSettings()) {
  return MODULE_IDS.filter((id) => moduleOn(settings, id));
}

// The modules as the dashboard lists them.
function listModules(settings = readSettings()) {
  return MODULES.map((m) => ({ ...m, enabled: moduleOn(settings, m.id) }));
}

export { checkoutDir, modulesDir, moduleEnabled, enabledModuleIds, listModules };
