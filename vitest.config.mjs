import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(ROOT, 'test', 'fixtures');

export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
    // pointe la logique back sur les fixtures (au lieu de ~/.claude)
    env: {
      HOOKED_PROJECTS_DIR: path.join(FX, 'projects'),
      HOOKED_DATA_DIR: path.join(FX, 'data'),
      // provider vibe : dossiers vides par défaut (n'existent pas → scan/lecture vides) ;
      // test/vibe.test.mjs passe son propre dossier de fixtures en argument explicite.
      HOOKED_VIBE_SESSIONS_DIR: path.join(FX, 'vibe-session-empty'),
      HOOKED_VIBE_DATA_DIR: path.join(FX, 'vibe-data-empty'),
    },
    server: {
      // node:sqlite est un module natif Node 24 : il doit être chargé tel quel,
      // jamais transformé/bundlé par Vite (sinon "Failed to load url sqlite").
      deps: { external: [/^node:/] },
    },
  },
});
