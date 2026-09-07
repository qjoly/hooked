import { redirect } from '@sveltejs/kit';

// Redesign: the kanban board is superseded by the Deck (fleet + decision queue).
export function load() {
  redirect(307, '/');
}
