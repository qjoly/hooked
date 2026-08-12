import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// The structural (layout) CSS of Pierre diffs is only applied by the <diffs-container> custom
// element from `@pierre/diffs/dist/components/web-components.js`. That file is NOT exposed in
// the package `exports` field → a direct import fails at build time. We alias it to its real
// path (the module is purely a side effect: it registers the custom element and adopts the
// base stylesheet).
// The package exposes only an `import` condition (no `require`, and `package.json` is not
// exported), so require.resolve can't find it. Point straight at the file under node_modules,
// relative to this config.
const pierreWebComponents = fileURLToPath(
  new URL('./node_modules/@pierre/diffs/dist/components/web-components.js', import.meta.url),
);

// Monaco 0.56 expose ses sous-modules via un `exports` en wildcard (`"./*": "./esm/vs/*.js"`).
// Le résolveur de Rollup/Vite ne matche pas ce wildcard pour les workers de langage importés en
// `…?worker` (« failed to resolve import monaco-editor/language/json/json.worker?worker »). On
// contourne `exports` en aliasant CHAQUE worker vers son vrai fichier sous node_modules, tout en
// PRÉSERVANT le suffixe `?worker` (lookahead) pour que le plugin worker de Vite le construise.
const monacoEsmVs = fileURLToPath(new URL('./node_modules/monaco-editor/esm/vs/', import.meta.url));
const monacoWorkerAlias = { find: /^monaco-editor\/(.*\.worker)(?=\?worker$)/, replacement: monacoEsmVs + '$1' };

// Front + API dans un seul process : `npm run dev` sert le front (HMR) ET les
// endpoints /api/* (routes +server.js). Plus de proxy ni de serveur Node séparé.
export default defineConfig({
  plugins: [sveltekit()],
  server: {
    allowedHosts: true,
  },
  resolve: {
    // Forme tableau (regex possible) : l'alias worker Monaco a besoin d'un `find` RegExp.
    alias: [
      { find: '@pierre/diffs/web-components', replacement: pierreWebComponents },
      monacoWorkerAlias,
    ],
  },
  // On EXCLUT monaco du dep-optimizer : sinon Vite tente de pré-bundler ses imports `…?worker` et
  // sert des URLs `.vite/deps/…_worker?worker.js` qui 404 → « Failed to fetch dynamically imported
  // module …/monaco.js » et l'éditeur ne monte jamais. Exclu, monaco + ses workers sont servis
  // depuis la source et le plugin worker de Vite les construit correctement.
  optimizeDeps: {
    exclude: ['monaco-editor'],
  },
});
