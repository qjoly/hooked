// Compiles one extension page; run by server/extensionPages.js as a child process, with
// `node compilePage.mjs <json>` where json = { srcDir, outDir, shared, uiExports }.
//
// A process of its own because vite.build() sets process.env.NODE_ENV for its run: inside the
// service, every session spawned meanwhile inherited NODE_ENV=production (and an `npm ci` run by
// one of them then dropped the dev dependencies this compiler needs). It also keeps the compile
// off the service's event loop.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const VIRTUAL = '\0hooked-ext:';
const { srcDir, outDir, shared, uiExports } = JSON.parse(process.argv[2]);
const req = createRequire(path.join(process.cwd(), 'package.json'));
const load = (spec) => import(pathToFileURL(req.resolve(spec)).href);

// The browser entry of each shared Svelte module, read from svelte's own `exports` map: the export
// names must be those of the client build the dashboard ships, not of the server one Node resolves.
async function exportNames() {
  const pkgFile = req.resolve('svelte/package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const browserEntry = (e) => (typeof e === 'string' ? e : e && (browserEntry(e.browser) || browserEntry(e.default)));
  const names = { '@hooked/ext/ui': uiExports };
  for (const spec of shared.filter((s) => s.startsWith('svelte'))) {
    const sub = spec === 'svelte' ? '.' : './' + spec.slice('svelte/'.length);
    const mod = await import(pathToFileURL(path.join(path.dirname(pkgFile), browserEntry(pkg.exports[sub]))).href);
    names[spec] = Object.keys(mod).filter((n) => n !== 'default');
  }
  return names;
}

function sharedRuntimePlugin(names) {
  // Importers come resolved through symlinks (macOS's /var → /private/var).
  const root = fs.realpathSync(srcDir);
  return {
    name: 'hooked-ext-shared-runtime',
    enforce: 'pre',
    resolveId(source, importer) {
      if (shared.includes(source)) return VIRTUAL + source;
      if (source.startsWith('\0') || !importer) return null;
      if (source.startsWith('.') || path.isAbsolute(source)) {
        const target = path.resolve(path.dirname(importer), source);
        if (target !== root && !target.startsWith(root + path.sep)) this.error(`import leaves the extension folder: ${source}`);
        return null;
      }
      this.error(`import not allowed in an extension page: ${source} (only ${shared.join(', ')})`);
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

try {
  const [{ build }, { svelte }, names] = await Promise.all([load('vite'), load('@sveltejs/vite-plugin-svelte'), exportNames()]);
  await build({
    configFile: false,
    envFile: false,
    root: srcDir,
    publicDir: false,
    logLevel: 'silent',
    mode: 'production',
    plugins: [svelte({ configFile: false, compilerOptions: { css: 'injected' } }), sharedRuntimePlugin(names)],
    build: {
      lib: { entry: path.join(srcDir, 'ui', 'Page.svelte'), formats: ['es'], fileName: () => 'page.js' },
      outDir,
      emptyOutDir: true,
      copyPublicDir: false,
      reportCompressedSize: false,
    },
  });
} catch (e) {
  process.stderr.write(String(e?.message || e));
  process.exit(1);
}
