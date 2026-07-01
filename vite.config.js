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

// Front + API dans un seul process : `npm run dev` sert le front (HMR) ET les
// endpoints /api/* (routes +server.js). Plus de proxy ni de serveur Node séparé.
export default defineConfig({
  plugins: [sveltekit()],
  server: {
    allowedHosts: true,
  },
  resolve: {
    alias: {
      '@pierre/diffs/web-components': pierreWebComponents,
    },
  },
});
