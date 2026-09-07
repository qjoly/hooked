import { json } from '@sveltejs/kit';
import { readAllMemories } from '$lib/server/core.js';

// Ce que Claude « sait » : les mémoires persistantes de chaque projet, groupées.
export function GET() {
  return json(readAllMemories());
}
