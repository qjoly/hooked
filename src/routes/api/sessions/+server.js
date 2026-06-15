import { json } from '@sveltejs/kit';
import { buildSessions } from '$lib/server/core.js';

export function GET() {
  return json({ sessions: buildSessions(), now: new Date().toISOString() });
}
