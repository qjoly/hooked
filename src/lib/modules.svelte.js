// Which of hooked's modules can work on the machine hooked runs on (GET /api/modules). Whether a
// module is on is a setting (settings.modules); this is the other half: incident.io, for one, needs
// its desktop app. Loaded once at startup.
import { jget } from './api.js';

export const modulesAvail = $state({});

export async function loadModules() {
  try {
    const r = await jget('/api/modules');
    for (const m of r.modules || []) modulesAvail[m.id] = m.available !== false;
  } catch (_) { /* keep every module available */ }
}
