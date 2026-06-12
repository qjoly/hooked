import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Front Svelte. Build → dist/ (servi par server.js en prod). En dev (`npm run dev`),
// serveur Vite sur :5173 qui proxifie l'API + le flux SSE vers le serveur Node (:4123).
export default defineConfig({
  plugins: [svelte()],
  publicDir: false, // public/ reste un fallback legacy côté serveur, pas une source Vite
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4123', changeOrigin: true },
    },
  },
});
