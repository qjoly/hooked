/*
 * Compiles an extension's web page (`ui/Page.svelte`) at runtime, with hooked's own Vite and
 * Svelte, into one ES module served by /_ext/ (docs/extensions.md). No rebuild of hooked.
 *
 * The page shares the dashboard's Svelte instance: every import of `svelte`, `svelte/*` and
 * `@hooked/ext/ui` becomes a read of `globalThis.__hookedExt`, which src/lib/ext/runtime.js fills
 * in the browser. One instance means one reactivity graph, so the page sees the same `data` the
 * rest of the dashboard does. Any other bare import fails the compile.
 *
 * vite and the Svelte plugin are loaded from node_modules at call time, never bundled into the
 * server build: the service runs from the checkout, where `npm ci` installs them (dev deps included).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { HOOKED_DIR } from './config.js';
import { EXTENSION_API } from './ext/context.js';

// Left to the runtime: bundling vite into the server build would break it.
const nativeImport = (url) => import(/* @vite-ignore */ url);

const SVELTE_SHARED = [
  'svelte', 'svelte/internal/client', 'svelte/internal/disclose-version', 'svelte/store',
  'svelte/reactivity', 'svelte/transition', 'svelte/animate', 'svelte/easing', 'svelte/motion',
  'svelte/events', 'svelte/attachments',
];
// What src/lib/ext/ui.js exports. test/extensionFacade.test.mjs keeps the two in step.
const UI_EXPORTS = [
  'jget', 'jpost', 'data', 'settings', 'extensionSettings', 'providerListAll', 'providerEngine',
  'effectiveProvider', 'knownProjects', 'fmtSpan', 'ago', 'flash', 'Icon', 'ModelEffort',
];
const SHARED_RUNTIME = [...SVELTE_SHARED, '@hooked/ext/ui'];

const CACHE_DIR = path.join(HOOKED_DIR, 'extension-cache');
const VIRTUAL = '\0hooked-ext:';

function checkoutRequire() {
  return createRequire(path.join(process.cwd(), 'package.json'));
}

// The browser entry of each shared Svelte module, read from svelte's own `exports` map: the export
// names must be those of the client build the dashboard ships, not of the server one Node resolves.
let svelteNames = null;
async function sharedExportNames() {
  if (svelteNames) return svelteNames;
  const pkgFile = checkoutRequire().resolve('svelte/package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const browserEntry = (e) => (typeof e === 'string' ? e : e && (browserEntry(e.browser) || browserEntry(e.default)));
  const names = { '@hooked/ext/ui': UI_EXPORTS };
  for (const spec of SVELTE_SHARED) {
    const sub = spec === 'svelte' ? '.' : './' + spec.slice('svelte/'.length);
    const mod = await nativeImport(pathToFileURL(path.join(path.dirname(pkgFile), browserEntry(pkg.exports[sub]))).href);
    names[spec] = Object.keys(mod).filter((n) => n !== 'default');
  }
  svelteNames = names;
  return names;
}

function svelteVersion() {
  return JSON.parse(fs.readFileSync(checkoutRequire().resolve('svelte/package.json'), 'utf8')).version;
}

// Same folder hash + same Svelte + same contract = same output, so a restart compiles nothing.
function pageKey(hash) {
  return crypto.createHash('sha256').update(`${hash}\0${svelteVersion()}\0${EXTENSION_API}`).digest('hex').slice(0, 16);
}

function sharedRuntimePlugin(dir, names) {
  // Importers come resolved through symlinks (macOS's /var → /private/var).
  const srcDir = fs.realpathSync(dir);
  return {
    name: 'hooked-ext-shared-runtime',
    enforce: 'pre',
    resolveId(source, importer) {
      if (SHARED_RUNTIME.includes(source)) return VIRTUAL + source;
      if (source.startsWith('\0') || !importer) return null;
      if (source.startsWith('.') || path.isAbsolute(source)) {
        const target = path.resolve(path.dirname(importer), source);
        if (target !== srcDir && !target.startsWith(srcDir + path.sep)) this.error(`import leaves the extension folder: ${source}`);
        return null;
      }
      this.error(`import not allowed in an extension page: ${source} (only ${SHARED_RUNTIME.join(', ')})`);
    },
    load(id) {
      if (!id.startsWith(VIRTUAL)) return null;
      const spec = id.slice(VIRTUAL.length);
      const list = names[spec];
      // Through local aliases: some export names (`await`) cannot be declared as bindings.
      const lines = [`const m = globalThis.__hookedExt[${JSON.stringify(spec)}];`];
      list.forEach((n, i) => lines.push(`const _${i} = m[${JSON.stringify(n)}];`));
      lines.push(`export { ${list.map((n, i) => `_${i} as ${n}`).join(', ')} };`);
      return lines.join('\n');
    },
  };
}

// → { url, key, ms, cached }. Throws with the compiler's message on failure.
async function compileExtensionPage({ id, hash, srcDir }) {
  const key = pageKey(hash);
  const outDir = path.join(CACHE_DIR, id, key);
  const file = path.join(outDir, 'page.js');
  const url = `/_ext/${id}/${key}/page.js`;
  if (fs.existsSync(file)) return { url, key, ms: 0, cached: true };

  const started = Date.now();
  const req = checkoutRequire();
  const [{ build }, { svelte }, names] = await Promise.all([
    nativeImport(pathToFileURL(req.resolve('vite')).href),
    nativeImport(pathToFileURL(req.resolve('@sveltejs/vite-plugin-svelte')).href),
    sharedExportNames(),
  ]);
  const tmpOut = outDir + '.tmp-' + process.pid;
  // vite.build() sets NODE_ENV for its own run; under `npm run live` that would flip the dev server.
  const nodeEnv = process.env.NODE_ENV;
  try {
    await build({
      configFile: false,
      envFile: false,
      root: srcDir,
      publicDir: false,
      logLevel: 'silent',
      mode: 'production',
      plugins: [svelte({ configFile: false, compilerOptions: { css: 'injected' } }), sharedRuntimePlugin(srcDir, names)],
      build: {
        lib: { entry: path.join(srcDir, 'ui', 'Page.svelte'), formats: ['es'], fileName: () => 'page.js' },
        outDir: tmpOut,
        emptyOutDir: true,
        copyPublicDir: false,
        reportCompressedSize: false,
      },
    });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
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
