import { json } from '@sveltejs/kit';
import { listModules } from '#lib/server/core.js';

// hooked's modules and whether each is on. Switching one is a settings change (`modules`).
export function GET() {
  return json({ modules: listModules() });
}
