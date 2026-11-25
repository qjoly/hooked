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

// Absolute path of the modules folder, or null.
function modulesDir() {
  if (process.env.HOOKED_MODULES_DIR) return process.env.HOOKED_MODULES_DIR;
  for (const root of ROOT_CANDIDATES) {
    const dir = path.join(root, 'modules');
    try { if (fs.statSync(path.join(dir, 'index.js')).isFile()) return dir; } catch (_) { /* next */ }
  }
  return null;
}

function moduleEnabled(id, settings = readSettings()) {
  return MODULE_IDS.includes(id) && moduleOn(settings, id);
}

function enabledModuleIds(settings = readSettings()) {
  return MODULE_IDS.filter((id) => moduleOn(settings, id));
}

// The pi packages of the modules that are on (modules/<id>/pi), absolute paths.
function modulePiPackages(settings = readSettings()) {
  const dir = modulesDir();
  if (!dir) return [];
  return enabledModuleIds(settings)
    .map((id) => path.join(dir, id, 'pi'))
    .filter((p) => { try { return fs.statSync(path.join(p, 'package.json')).isFile(); } catch (_) { return false; } });
}

// The modules as the dashboard lists them.
function listModules(settings = readSettings()) {
  return MODULES.map((m) => ({ ...m, enabled: moduleOn(settings, m.id) }));
}

export { modulesDir, moduleEnabled, enabledModuleIds, modulePiPackages, listModules };
