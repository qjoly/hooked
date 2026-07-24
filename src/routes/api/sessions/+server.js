import { json } from '@sveltejs/kit';
import { buildSessionsWarm } from '$lib/server/core.js';

export async function GET() {
  return json({ sessions: await buildSessionsWarm(), now: new Date().toISOString() });
}
