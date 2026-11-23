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
      // provider pi : dossier vide par défaut (n'existe pas → scan/lecture vides) ;
      // test/pi.test.mjs passe son propre dossier de fixtures en argument explicite.
      HOOKED_PI_SESSIONS_DIR: path.join(FX, 'pi-session-empty'),
      // pi's agent dir (pi-claude-bridge state, catalog profile): a folder that does not exist, so
      // no test reads the real ~/.pi/agent. Tests that need one set their own before importing.
      PI_CODING_AGENT_DIR: path.join(FX, 'pi-agent-empty'),
    },
    server: {
      // node:sqlite est un module natif Node 24 : il doit être chargé tel quel,
      // jamais transformé/bundlé par Vite (sinon "Failed to load url sqlite").
      deps: { external: [/^node:/] },
    },
  },
});
