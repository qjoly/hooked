/*
 * Compiles an extension's web page (`ui/Page.svelte`) at runtime, with hooked's own Vite and
 * Svelte, into one ES module served by /_ext/ (docs/extensions.md). No rebuild of hooked.
 *
 * The page shares the dashboard's Svelte instance: every import of `svelte`, `svelte/*` and
 * `@hooked/ext/ui` becomes a read of `globalThis.__hookedExt`, which src/lib/ext/runtime.js fills
 * in the browser. One instance means one reactivity graph, so the page sees the same `data` the
 * rest of the dashboard does. Any other bare import fails the compile.
 *
 * The compile itself runs in a child process (server/ext/compilePage.mjs), with vite and the
 * Svelte plugin from the checkout's node_modules, where `npm ci` installs them (dev deps included).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { HOOKED_DIR } from './config.js';
import { EXTENSION_API } from './ext/context.js';
import { checkoutDir } from './moduleState.js';

const SVELTE_SHARED = [
  'svelte', 'svelte/internal/client', 'svelte/internal/disclose-version', 'svelte/store',
  'svelte/reactivity', 'svelte/transition', 'svelte/animate', 'svelte/easing', 'svelte/motion',
  'svelte/events', 'svelte/attachments',
];
// What src/lib/ext/ui.js exports. test/extensionPages.test.mjs keeps the two in step.
const UI_EXPORTS = [
  'jget', 'jpost', 'data', 'settings', 'extensionSettings', 'providerListAll', 'providerEngine',
  'effectiveProvider', 'knownProjects', 'fmtSpan', 'ago', 'flash', 'Icon', 'ModelEffort',
];
const SHARED_RUNTIME = [...SVELTE_SHARED, '@hooked/ext/ui'];
const COMPILE_TIMEOUT_MS = 60_000;

const CACHE_DIR = path.join(HOOKED_DIR, 'extension-cache');

function svelteVersion() {
  const req = createRequire(path.join(process.cwd(), 'package.json'));
  return JSON.parse(fs.readFileSync(req.resolve('svelte/package.json'), 'utf8')).version;
}

// Same folder hash + same Svelte + same contract = same output, so a restart compiles nothing.
function pageKey(hash) {
  return crypto.createHash('sha256').update(`${hash}\0${svelteVersion()}\0${EXTENSION_API}`).digest('hex').slice(0, 16);
}

function runCompiler(job) {
  const script = path.join(checkoutDir() || process.cwd(), 'server', 'ext', 'compilePage.mjs');
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, JSON.stringify(job)], { cwd: process.cwd(), timeout: COMPILE_TIMEOUT_MS }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr || '').trim() || err.message));
      else resolve();
    });
  });
}

// → { url, key, ms, cached }. Throws with the compiler's message on failure.
async function compileExtensionPage({ id, hash, srcDir }) {
  const key = pageKey(hash);
  const outDir = path.join(CACHE_DIR, id, key);
  const file = path.join(outDir, 'page.js');
  const url = `/_ext/${id}/${key}/page.js`;
  if (fs.existsSync(file)) return { url, key, ms: 0, cached: true };

  const started = Date.now();
  const tmpOut = outDir + '.tmp-' + process.pid;
  await runCompiler({ srcDir, outDir: tmpOut, shared: SHARED_RUNTIME, uiExports: UI_EXPORTS });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.renameSync(tmpOut, outDir);
  return { url, key, ms: Date.now() - started, cached: false };
}

// Path of a compiled file for /_ext/<id>/<key>/page.js, or null.
function extensionPageFile(rest) {
  const m = /^([a-z][a-z0-9-]{1,31})\/([0-9a-f]{16})\/page\.js$/.exec(rest || '');
  return m ? path.join(CACHE_DIR, m[1], m[2], 'page.js') : null;
}

export { SHARED_RUNTIME, UI_EXPORTS, compileExtensionPage, extensionPageFile };
