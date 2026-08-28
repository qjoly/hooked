import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // serveur Node long-running : nécessaire pour le SSE, les watchers fs, et parce que les
    // sessions Claude Code pilotées par l'Agent SDK vivent DANS ce processus.
    adapter: adapter(),
  },
};

export default config;
