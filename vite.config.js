import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Front + API dans un seul process : `npm run dev` sert le front (HMR) ET les
// endpoints /api/* (routes +server.js). Plus de proxy ni de serveur Node séparé.
export default defineConfig({
  plugins: [sveltekit()],
});
