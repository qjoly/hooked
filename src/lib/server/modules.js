// API routes of a module answer 404 while the module is switched off (Settings → Modules).
import { MODULES } from '#modules/index.js';
import { moduleEnabled } from '#server/moduleState.js';
import { fail } from './respond.js';

export function gated(id, handler) {
  const label = MODULES.find((m) => m.id === id)?.label || id;
  return (event) => (moduleEnabled(id) ? handler(event) : fail(404, `the ${label} module is off (Settings → Modules)`));
}
