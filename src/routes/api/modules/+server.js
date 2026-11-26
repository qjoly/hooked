import { json } from '@sveltejs/kit';
import { listModules, moduleAvailability } from '#lib/server/core.js';

// hooked's modules: whether each is on (a settings change, `modules`) and can work on this machine.
export function GET() {
  const avail = moduleAvailability();
  return json({ modules: listModules().map((m) => ({ ...m, available: avail[m.id] !== false })) });
}
