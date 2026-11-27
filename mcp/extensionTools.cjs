/*
 * Loads the agent tools of extensions and modules (their tools.cjs) for the MCP server and for
 * hooked's pi package. hooked passes the files to load, already in order, in
 * HOOKED_EXTENSION_TOOLS (comma-separated absolute paths): the order is part of every session's
 * prompt prefix, so it is decided once, by hooked (server/extensions.js `sessionToolFiles`).
 */
'use strict';

const fs = require('fs');
const path = require('path');

// tools.cjs is a factory `(h) => ({ tools })` (extension contract) or, for a module written before
// it, the `{ tools }` object itself.
function loadToolDefs(file, helpers) {
  const mod = require(file);
  const def = typeof mod === 'function' ? mod(helpers) : mod;
  return Array.isArray(def && def.tools) ? def.tools : [];
}

function parseToolFiles(list) {
  return String(list || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// A file that fails to load is skipped: one broken extension never takes the server down.
function toolsFromFiles(files, helpers) {
  const out = [];
  for (const file of files) {
    try { out.push(...loadToolDefs(file, helpers)); } catch (e) {
      process.stderr.write(`[hooked] tools of ${file}: ${(e && e.message) || e}\n`);
    }
  }
  return out;
}

// A server started by hand (no HOOKED_EXTENSION_TOOLS): every module and extension on disk, by id.
// A module or bundled extension wins over an installed extension with the same id.
function toolFilesOnDisk(checkout, installedDir) {
  const byId = new Map();
  for (const root of [path.join(checkout, 'modules'), path.join(checkout, 'extensions'), installedDir]) {
    let ids = [];
    try { ids = fs.readdirSync(root); } catch (_) { continue; }
    for (const id of ids) {
      const file = path.join(root, id, 'tools.cjs');
      if (!byId.has(id) && !id.startsWith('.') && fs.existsSync(file)) byId.set(id, file);
    }
  }
  return [...byId.keys()].sort().map((id) => byId.get(id));
}

module.exports = { loadToolDefs, parseToolFiles, toolsFromFiles, toolFilesOnDisk };
