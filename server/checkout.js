/*
 * Where hooked's own checkout is: the folder holding mcp/, extensions/ and server/.
 */
import fs from 'node:fs';
import path from 'node:path';

// The repo root can't be derived from import.meta.dirname alone: in dev this file runs from
// <repo>/server, the prod bundle from build/server/chunks. process.cwd() first: `npm run live` and
// `node build` both run at the repo root.
const ROOT_CANDIDATES = [
  process.cwd(),
  path.join(import.meta.dirname, '..'),
  path.join(import.meta.dirname, '..', '..'),
  path.join(import.meta.dirname, '..', '..', '..'),
];

// Absolute path of hooked's checkout, or null.
function checkoutDir() {
  for (const root of ROOT_CANDIDATES) {
    try { if (fs.statSync(path.join(root, 'mcp', 'extensionTools.cjs')).isFile()) return root; } catch (_) { /* next */ }
  }
  return null;
}

export { checkoutDir };
