import { json } from '@sveltejs/kit';
import { buildUsage } from '$lib/server/core.js';

export function GET() {
  return json(buildUsage());
}
